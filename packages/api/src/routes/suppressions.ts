/**
 * Suppression routes.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * They are registered under the /v1 prefix inside the authenticated scope.
 *
 * Endpoints:
 *   POST   /v1/suppressions          add a single address (manual block), or
 *                                    { emails: [...], reason } in bulk (G12)
 *   POST   /v1/suppressions/import   bulk import from plain-text or CSV body
 *   GET    /v1/suppressions          list tenant's suppressions (paginated, ?since=)
 *   DELETE /v1/suppressions/:email   remove one (complaint / hard_bounce need ?force=1)
 *
 * Every route also accepts a product admin key with the `suppressions`
 * scope (G1).
 *
 * Suppression import (task 24):
 *   Accepts a plain-text or CSV body (Content-Type: text/plain or text/csv)
 *   with one email address per line. An optional header row whose first field
 *   is "email" (case-insensitive) is silently skipped.
 *
 *   [impl] Input format: plain text (one email per line) or CSV. Only the
 *   first field of each line is read; additional CSV columns are ignored.
 *   Empty lines and blank-after-trim lines are skipped silently.
 *
 *   [impl] Row ceiling: SUPPRESSION_IMPORT_ROW_CAP = 10_000 rows per call.
 *   Processing is synchronous (in-memory bulk INSERT). For larger imports,
 *   split the file and call the endpoint multiple times.
 *
 *   [impl] Validation: an address must contain exactly one '@' with a non-empty
 *   local part and a non-empty domain part (containing at least one '.'). Rows
 *   that fail validation are counted as 'invalid' in the response but do NOT
 *   abort the batch. One bad row never fails the whole import.
 *
 *   [impl] Duplicate handling: a row already suppressed for this tenant is
 *   not an error. The INSERT uses ON CONFLICT DO NOTHING; the row is counted
 *   as 'skipped' in the response.
 *
 *   [impl] Import is additive: it never removes existing suppressions.
 *
 *   [impl] Reason and source: all rows imported via this endpoint get
 *   reason = 'imported' and source = 'csv_import', matching the vocabulary
 *   already in the suppressions table schema.
 *
 *   [impl] Case normalization: imported addresses are lowercased before storage.
 *   The L1 suppression gate in drain.ts queries suppressions.email with a
 *   case-sensitive equality against contacts.email (which is stored as-is by
 *   the identify path - no normalization). This means a contact stored as
 *   'Alice@EXAMPLE.COM' is NOT blocked by an import of 'alice@example.com'.
 *   The correct fix requires a Postgres functional index on lower(email) and
 *   a gate query update - both require a migration. See docs/BACKLOG.md
 *   "suppression case-insensitive lookup" for the tracking item and migration
 *   proposal. Until then, import lowercases to at least be consistent with
 *   itself (dedup within the import works correctly; gate coverage depends on
 *   the case used in contacts.email).
 *
 *   Response: { imported, skipped, invalid, total_rows }.
 *
 * Suppression list endpoint:
 *   Uses the same cursor-based pagination convention as GET /v1/kb:
 *   keyed on (created_at, id), ?limit= (default 50, max 200), ?after=<cursor>,
 *   next_cursor in the response.
 */
import { RoleRouter, allowAdminKey } from "../http/router.js";
import { storeFor } from "@claros/store";
import type { Db } from "../plugins/db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of rows processed per POST /v1/suppressions/import call.
 * [impl] Unvalidated starting value. At ~30 chars/address, 10,000 rows ≈ 300KB.
 * Split the file for larger imports.
 */
const SUPPRESSION_IMPORT_ROW_CAP = 10_000;

/** Default page size for GET /v1/suppressions list. */
const DEFAULT_PAGE_SIZE = 50;

/** Maximum page size for GET /v1/suppressions list. */
const MAX_PAGE_SIZE = 200;

/** Maximum addresses in one bulk POST /v1/suppressions call. */
const BULK_MAX = 1000;

/** Reasons a bulk suppression may carry. */
const BULK_REASONS = ["manual", "unsubscribe", "hard_bounce", "complaint", "imported"] as const;

/** Suppressions only removed with ?force=1: the provider reported them. */
const PROTECTED_REASONS = ["complaint", "hard_bounce"];

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

/**
 * Basic structural email address validation.
 * Checks for: exactly one '@', non-empty local part, non-empty domain with
 * at least one '.'. Does not perform DNS resolution or full RFC 5321 parsing.
 */
function isValidEmail(address: string): boolean {
  const atIdx = address.indexOf("@");
  if (atIdx <= 0) return false;                          // no '@' or empty local
  if (address.indexOf("@", atIdx + 1) !== -1) return false; // multiple '@'
  const domain = address.slice(atIdx + 1);
  if (domain.length === 0) return false;
  if (!domain.includes(".")) return false;               // no dot in domain
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Cursor helpers (same as GET /v1/kb)
// ---------------------------------------------------------------------------

interface CursorPayload {
  created_at: string;
  id: string;
}

function encodeCursor(createdAt: Date | null | undefined, id: string): string {
  const payload: CursorPayload = {
    created_at: (createdAt ?? new Date(0)).toISOString(),
    id,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as Record<string, unknown>).created_at !== "string" ||
      typeof (parsed as Record<string, unknown>).id !== "string"
    ) return null;
    return parsed as CursorPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export default function suppressionRoutes() {
  // Register text/plain and text/csv content type parsers for this scope.
  // These are used by the import endpoint to read raw email lists.
  // JSON is handled by the default body parser.
  const rawText = (raw: string): string => raw;
  const r = new RoleRouter({
    parsers: {
      "text/plain": rawText,
      "text/csv": rawText,
      "application/csv": rawText,
    },
  });
  /**
   * POST /v1/suppressions
   *
   * Manually suppress a single address from the dashboard.
   * Body (JSON): { "email": "a@b.com" }
   *
   * The address is lowercased before storage (same normalization as import).
   * Rows written here get reason = 'manual' and source = 'admin', the
   * vocabulary the schema already reserves for operator-added blocks.
   *
   * Idempotent: an already-suppressed address is not an error. Returns
   * 201 { email, added: true } on a new row, 200 { email, added: false }
   * when the address was already suppressed.
   */
  r.post("/", "member", allowAdminKey("suppressions"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const body = c.var.body as Record<string, unknown> | null;

    // Bulk form (G12): { emails: string[], reason? }.
    if (body && typeof body === "object" && "emails" in body) {
      if (!Array.isArray(body.emails) || body.emails.length === 0 || body.emails.length > BULK_MAX) {
        return c.json({ error: `'emails' must be an array of 1-${BULK_MAX} addresses.` }, 400);
      }
      const reason = body.reason === undefined ? "manual" : body.reason;
      if (typeof reason !== "string" || !(BULK_REASONS as readonly string[]).includes(reason)) {
        return c.json({ error: `'reason' must be one of: ${BULK_REASONS.join(", ")}.` }, 400);
      }
      const valid: string[] = [];
      const invalid: unknown[] = [];
      for (const raw of body.emails) {
        const e = typeof raw === "string" ? raw.trim().toLowerCase() : "";
        if (isValidEmail(e)) valid.push(e);
        else invalid.push(raw);
      }
      const added = await storeFor(db).apiSuppressions.addSuppressions({
        tenantId,
        emails: valid,
        reason,
        source: c.var.tenant!.apiKeyId ? "api" : "admin",
        now: new Date(),
      });
      return c.json({ added, skipped: valid.length - added.length, invalid });
    }

    const email = typeof body?.email === "string"
      ? body.email.trim().toLowerCase()
      : "";

    if (!isValidEmail(email)) {
      return c.json({ error: "Body must contain a valid 'email' address." }, 400);
    }

    // Same row as v0.6 (reason manual, source admin), plus contact.suppressed (G5).
    const added =
      (await storeFor(db).apiSuppressions.addSuppressions({ tenantId, emails: [email], reason: "manual", source: "admin", now: new Date() })).length > 0;
    return c.json({ email, added }, added ? 201 : 200);
  });

  /**
   * POST /v1/suppressions/import
   *
   * Body: plain-text or CSV. Content-Type: text/plain, text/csv, or any text/*.
   * Also accepts application/json with a { "addresses": string[] } shape for
   * programmatic callers who prefer not to send a text body.
   *
   * Returns { imported, skipped, invalid, total_rows }.
   */
  r.post("/import", "member", allowAdminKey("suppressions"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    // ---------------------------------------------------------------------------
    // Parse the body into a list of candidate email strings
    // ---------------------------------------------------------------------------

    let lines: string[];

    const contentType = (c.req.header("content-type") ?? "").toLowerCase();

    if (contentType.includes("application/json")) {
      // JSON shape: { "addresses": ["a@b.com", ...] }
      const body = c.var.body as Record<string, unknown>;
      if (!Array.isArray(body?.addresses)) {
        return c.json({ error: "JSON body must have an 'addresses' array." }, 400);
      }
      lines = (body.addresses as unknown[]).map(String);
    } else {
      // Plain text / CSV: read the raw body string
      const raw = c.var.body as string;
      if (typeof raw !== "string" || raw.length === 0) {
        return c.json({ error: "Body must be a non-empty text document or JSON {addresses:[...]}." }, 400);
      }
      lines = raw.split(/\r?\n/);
    }

    // Apply row cap before any processing
    const cappedLines = lines.slice(0, SUPPRESSION_IMPORT_ROW_CAP + 1); // +1 to detect overflow

    let totalRows = 0;     // raw non-empty lines seen (before cap)
    let imported = 0;
    let skipped = 0;       // duplicates (existing rows)
    let invalid = 0;

    const toInsert: string[] = [];

    for (const rawLine of cappedLines) {
      // Take only the first CSV field in case of multi-column input
      const raw = rawLine.split(",")[0]!.trim().toLowerCase();
      if (raw.length === 0) continue; // blank line
      // Skip a header row ("email" as the first field, case-insensitive)
      if (totalRows === 0 && raw === "email") continue;

      totalRows++;

      if (!isValidEmail(raw)) {
        invalid++;
        continue;
      }

      toInsert.push(raw);
    }

    // Bulk insert with ON CONFLICT DO NOTHING
    if (toInsert.length > 0) {
      // Emails are already lowercased above (line 188). The store method
      // detects conflicts case-insensitively on (tenant_id, lower(email)), so
      // both within-batch duplicates and existing rows are caught.
      // P5b: the same insert as importSuppressions (reason imported, source
      // csv_import), plus contact.suppressed per inserted address (G5).
      // Chunks keep each atomic unit (a D1 batch) small.
      const now = new Date();
      imported = 0;
      for (let i = 0; i < toInsert.length; i += 200) {
        imported += (
          await storeFor(db).apiSuppressions.addSuppressions({ tenantId, emails: toInsert.slice(i, i + 200), reason: "imported", source: "csv_import", now })
        ).length;
      }
      skipped = toInsert.length - imported; // rows in batch that conflicted
    }

    return c.json({ imported, skipped, invalid, total_rows: totalRows }, 200);
  });

  /**
   * GET /v1/suppressions
   * List suppressions for the tenant with cursor-based pagination.
   *
   * Same cursor convention as GET /v1/kb:
   *   ?limit=<n>       (default 50, max 200)
   *   ?after=<cursor>  opaque cursor from previous page's next_cursor
   *
   * Response: { suppressions: SuppressionEntry[], next_cursor: string | null }
   */
  r.get("/", "member", allowAdminKey("suppressions"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const query = c.req.query() as { limit?: string; after?: string; since?: string };
    let since: Date | null = null;
    if (query.since !== undefined) {
      since = new Date(query.since);
      if (Number.isNaN(since.getTime())) {
        return c.json({ error: "'since' must be an ISO-8601 timestamp." }, 400);
      }
    }

    const rawLimit = parseInt(query.limit ?? "", 10);
    const limit = isNaN(rawLimit) || rawLimit < 1
      ? DEFAULT_PAGE_SIZE
      : Math.min(rawLimit, MAX_PAGE_SIZE);
    const fetchLimit = limit + 1;

    let cursor: CursorPayload | null = null;
    if (query.after) {
      cursor = decodeCursor(query.after);
    }

    const rows = await storeFor(db).apiSuppressions.listSuppressions({
      tenantId,
      after: cursor ? { createdAt: cursor.created_at, id: cursor.id } : null,
      limit: fetchLimit,
      since,
    });

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor = hasNextPage && lastRow
      ? encodeCursor(lastRow.createdAt, lastRow.id)
      : null;

    return c.json({
      suppressions: pageRows.map((r) => ({
        id: r.id,
        tenant_id: r.tenantId,
        email: r.email,
        reason: r.reason,
        source: r.source,
        created_at: r.createdAt,
      })),
      next_cursor: nextCursor,
    });
  });
  /**
   * DELETE /v1/suppressions/:email (G12)
   *
   * Remove one suppression (case-insensitive). Complaint and hard-bounce
   * suppressions are refused with 409 unless ?force=1: the provider reported
   * them, and mailing the address again hurts deliverability.
   */
  r.delete("/:email", "member", allowAdminKey("suppressions"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const email = decodeURIComponent(c.req.param("email")!).trim().toLowerCase();
    if (!isValidEmail(email)) {
      return c.json({ error: "Not a valid email address." }, 400);
    }
    const force = c.req.query("force") === "1" || c.req.query("force") === "true";
    const out = await storeFor(db).apiSuppressions.removeSuppression({
      tenantId,
      email,
      force,
      protectedReasons: PROTECTED_REASONS,
      now: new Date(),
    });
    if (out.result === "not_found") return c.json({ error: "Address is not suppressed." }, 404);
    if (out.result === "protected") {
      return c.json({ error: `Suppression reason '${out.reason}' is removed only with ?force=1.`, reason: out.reason }, 409);
    }
    return c.json({ email, deleted: true, reason: out.reason });
  });

  return r.app;
}
