/**
 * Suppression routes.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * They are registered under the /v1 prefix inside the authenticated scope.
 *
 * Endpoints:
 *   POST /v1/suppressions          add a single address (manual block)
 *   POST /v1/suppressions/import   bulk import from plain-text or CSV body
 *   GET  /v1/suppressions          list tenant's suppressions (paginated)
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
import { RoleRouter } from "../http/router.js";
import { eq, and, sql } from "drizzle-orm";
import { suppressions } from "@claros/db/schema";
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
  r.post("/", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const body = c.var.body as Record<string, unknown> | null;
    const email = typeof body?.email === "string"
      ? body.email.trim().toLowerCase()
      : "";

    if (!isValidEmail(email)) {
      return c.json({ error: "Body must contain a valid 'email' address." }, 400);
    }

    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO suppressions (tenant_id, email, reason, source)
      VALUES (${tenantId}::uuid, ${email}, 'manual', 'admin')
      ON CONFLICT (tenant_id, lower(email)) DO NOTHING
      RETURNING id
    `);

    const added = result.rows.length > 0;
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
  r.post("/import", "member", async (c) => {
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
      // Emails are already lowercased above (line 188). The ON CONFLICT clause
      // must reference the functional index expression (tenant_id, lower(email))
      // so Postgres uses the uq_suppressions_tenant_email_lower index to detect
      // conflicts. Both within-batch duplicates and existing rows are caught.
      const emailsSql = sql.join(
        toInsert.map((e) => sql`${e}`),
        sql`, `,
      );

      const result = await db.execute<{ id: string }>(sql`
        INSERT INTO suppressions (tenant_id, email, reason, source)
        SELECT ${tenantId}::uuid, e.email, 'imported', 'csv_import'
        FROM unnest(ARRAY[${emailsSql}]::text[]) AS e(email)
        ON CONFLICT (tenant_id, lower(email)) DO NOTHING
        RETURNING id
      `);

      imported = result.rows.length;
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
  r.get("/", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const query = c.req.query() as { limit?: string; after?: string };

    const rawLimit = parseInt(query.limit ?? "", 10);
    const limit = isNaN(rawLimit) || rawLimit < 1
      ? DEFAULT_PAGE_SIZE
      : Math.min(rawLimit, MAX_PAGE_SIZE);
    const fetchLimit = limit + 1;

    let cursor: CursorPayload | null = null;
    if (query.after) {
      cursor = decodeCursor(query.after);
    }

    let rows: (typeof suppressions.$inferSelect)[];

    if (cursor) {
      const cursorCreatedAt = cursor.created_at;
      const cursorId = cursor.id;

      rows = await db
        .select()
        .from(suppressions)
        .where(
          and(
            eq(suppressions.tenantId, tenantId),
            sql`
              ROW(date_trunc('milliseconds', ${suppressions.createdAt}), ${suppressions.id}) >
              ROW(${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
            `,
          ),
        )
        .orderBy(sql`date_trunc('milliseconds', ${suppressions.createdAt}) ASC`, suppressions.id)
        .limit(fetchLimit);
    } else {
      rows = await db
        .select()
        .from(suppressions)
        .where(eq(suppressions.tenantId, tenantId))
        .orderBy(sql`date_trunc('milliseconds', ${suppressions.createdAt}) ASC`, suppressions.id)
        .limit(fetchLimit);
    }

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
  return r.app;
}
