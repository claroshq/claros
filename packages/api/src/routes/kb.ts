/**
 * Knowledge base (KB) entry CRUD routes.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * They are registered under the /v1 prefix inside the authenticated scope in
 * app.ts, which enforces request.tenant !== null before any route handler runs.
 *
 * Endpoints:
 *   POST   /v1/kb              create an entry
 *   GET    /v1/kb              list entries (paginated; see pagination section)
 *   GET    /v1/kb/:id          get a single entry (full content)
 *   PATCH  /v1/kb/:id          partial update (only supplied fields are updated)
 *   DELETE /v1/kb/:id          hard delete
 *
 * Ownership:
 *   Every operation is scoped to the calling tenant. A request for an entry
 *   that belongs to another tenant returns 404 (not 403) to avoid leaking
 *   information about which IDs exist.
 *
 * Embedding:
 *   The embedding column is nullable. Creating or updating an entry enqueues
 *   an embedding job (task 22). The embedding is never set or returned by
 *   these CRUD routes.
 *
 * Deletion:
 *   Hard delete (physical row removal). No other table holds an FK reference
 *   to kb_entries. The is_active flag exists to deactivate entries without
 *   removing them; DELETE is a true removal.
 *
 * Pagination (list endpoint):
 *   [impl] The KB list uses cursor-based pagination keyed on (created_at, id).
 *   This is the codebase convention for any list endpoint that may grow large:
 *   use cursor pagination rather than offset, with a base64-encoded JSON cursor
 *   carrying { created_at: ISO string, id: UUID }.
 *
 *   Request:
 *     ?limit=<n>         Number of entries to return. Default: 50. Max: 200.
 *     ?after=<cursor>    Opaque cursor from the previous page's next_cursor.
 *     ?include_inactive  Include is_active=false entries (default: active only).
 *
 *   Response:
 *     { entries: EntryPreview[], next_cursor: string | null }
 *     - next_cursor is null when no further pages exist.
 *     - total is intentionally omitted (expensive on large tables).
 *
 *   The list returns content_preview (first 300 characters of content), not
 *   the full content. Full content is returned only by GET /v1/kb/:id.
 *   Preview length: 300 characters. Truncation appended with "..." when the
 *   original is longer.
 *
 *   Index note: the cursor ORDER BY clause is (created_at ASC, id ASC),
 *   served by idx_kb_entries_tenant_created (tenant_id, created_at, id),
 *   added in migration 0018.
 */
import { RoleRouter } from "../http/router.js";
import type { AppContext } from "../http/env.js";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { kbEntries } from "@claros/db/schema";
import { QUEUE } from "@claros/core";
import type { Db } from "../plugins/db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTENT_TYPES = ["markdown", "html", "text"] as const;
const SOURCES = ["manual", "crawl", "upload"] as const;

/** Number of characters returned in the list content preview. */
const CONTENT_PREVIEW_LENGTH = 300;

/**
 * Maximum length for an entry title.
 *
 * [impl] Unvalidated starting value. Titles are used as kb_ref anchors and
 * shown in list UIs; 200 chars is generous for both.
 */
export const KB_TITLE_MAX_CHARS = 200;

/**
 * Maximum length for entry content.
 *
 * [impl] Unvalidated starting value. The entry content is injected verbatim
 * into the draft prompt when retrieved (context-kb.ts); at ~4 chars/token an
 * 8000-char entry costs ~2000 tokens against a 4000-token context budget
 * (MAX_CONTEXT_TOKENS). Larger entries would push the whole kb_context
 * section over budget and get it dropped, so the cap protects retrieval
 * usefulness rather than the token bill. Well below the embedding truncation
 * ceiling (EMBEDDING_MAX_CHARS = 32000 in embed-kb.ts).
 */
export const KB_CONTENT_MAX_CHARS = 8_000;

/** Default page size for the list endpoint. */
const DEFAULT_PAGE_SIZE = 50;

/** Maximum page size for the list endpoint. Requests above this are clamped. */
const MAX_PAGE_SIZE = 200;

/**
 * Maximum number of entries enqueued per POST /v1/kb/re-embed call.
 *
 * [impl] Unvalidated starting value. A tenant whose entire KB failed at once
 * (credential rotation scenario) should not queue an unbounded number of
 * embedding API calls in a single request. 100 entries × one API call each
 * is a reasonable page size for a recovery operation. The response reports
 * `remaining` so the operator knows when another call is needed.
 */
const RE_EMBED_BATCH_CAP = 100;

/**
 * Minutes after which a 'pending' entry with no embedding is treated as an
 * orphan by POST /v1/kb/re-embed.
 *
 * [impl] An orphan is an entry set to embedding_status = 'pending' where the
 * process died before boss.send() completed, leaving no job in the pg-boss
 * queue. Querying pgboss.job directly is not reliable: the pgboss schema
 * is in a different schema (only present when the app has run), and the
 * KB_EMBED queue uses standard policy so singletonKey is NOT enforced as
 * unique in pg-boss (no unique index for standard policy queues). The
 * only reliable signal is time: a job that has not produced an embedding
 * within the expiry window (expireInMinutes: 10) is either an orphan or
 * has permanently failed.
 *
 * The threshold (15 min) is chosen as:
 *   - larger than expireInMinutes (10 min) on the KB_EMBED job: an active
 *     job will either succeed, fail, or expire before this threshold fires
 *   - small enough that an operator waiting before re-pressing the button
 *     will pick up orphans without a long wait
 *
 * Failure modes:
 *   1. A provider taking >10 min to respond would have its job expire anyway
 *      (expireInMinutes: 10). No live job can persist past 10 min.
 *   2. An operator calling re-embed within 15 min of an orphan being created
 *      would miss it. The recommendation is to wait 15+ min before calling
 *      re-embed for orphan recovery.
 *   3. Clock skew between processes: the threshold uses the DB server's now(),
 *      not the API server clock, so the comparison is always consistent within
 *      the DB.
 */
const RE_EMBED_ORPHAN_THRESHOLD_MINUTES = 15;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createKbEntrySchema = z.object({
  title: z
    .string()
    .min(1, "title is required")
    .max(KB_TITLE_MAX_CHARS, `title must be at most ${KB_TITLE_MAX_CHARS} characters`),
  content: z
    .string()
    .min(1, "content is required")
    .max(KB_CONTENT_MAX_CHARS, `content must be at most ${KB_CONTENT_MAX_CHARS} characters`),
  content_type: z.enum(CONTENT_TYPES).optional(),
  source: z.enum(SOURCES).optional(),
  source_url: z.string().optional(),
  tags: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});

// Update: all fields optional; cannot set embedding via API
const updateKbEntrySchema = createKbEntrySchema.partial();

export type CreateKbEntryBody = z.infer<typeof createKbEntrySchema>;
export type UpdateKbEntryBody = z.infer<typeof updateKbEntrySchema>;

// ---------------------------------------------------------------------------
// Cursor encoding / decoding
// ---------------------------------------------------------------------------

interface CursorPayload {
  created_at: string; // ISO 8601
  id: string;         // UUID
}

/**
 * Encode a (created_at, id) pair to a base64 cursor string.
 */
function encodeCursor(createdAt: Date | null | undefined, id: string): string {
  const payload: CursorPayload = {
    created_at: (createdAt ?? new Date(0)).toISOString(),
    id,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Decode a cursor string. Returns null if the cursor is malformed.
 */
function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).created_at !== "string" ||
      typeof (parsed as Record<string, unknown>).id !== "string"
    ) {
      return null;
    }
    return parsed as CursorPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return 400 with Zod validation issues, matching the error shape in flows.ts.
 */
function validationError(c: AppContext, issues: z.ZodIssue[]) {
  return c.json({
    error: "Validation failed",
    issues: issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  }, 400);
}

/**
 * Truncate content to CONTENT_PREVIEW_LENGTH characters for list responses.
 * Appends "..." when truncation occurs.
 */
function makePreview(content: string): string {
  if (content.length <= CONTENT_PREVIEW_LENGTH) return content;
  return content.slice(0, CONTENT_PREVIEW_LENGTH) + "...";
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export default function kbRoutes() {
  const r = new RoleRouter();
  /**
   * POST /v1/kb
   * Create a new knowledge base entry.
   *
   * Gap 2 fix: embedding_status is set to 'pending' on INSERT so the state
   * is immediately operator-visible. embedding = NULL + status = 'pending'
   * means a job has been enqueued (or will be re-enqueued on orphan repair).
   *
   * Gap 3 note: the INSERT and boss.send() are sequential, not atomic. A crash
   * between the two leaves an entry with embedding_status = 'pending' and no
   * job in the queue. This is observable and repairable (see BACKLOG.md
   * "KB embedding orphan repair"). The transaction approach (boss.send inside
   * a Drizzle tx via fromDrizzle) would require pg-boss as an api dependency,
   * which violates the api ← {core,adapters} dependency graph rule. The
   * fire-and-forget + observable-orphan pattern is the same one used by the
   * ingest route for TRIGGER_CHECK, where the 15-min scan is the repair path.
   * Here, the repair path is the orphan scan (BACKLOG).
   *
   * When enqueue is not available (tests without pg-boss), embedding_status
   * is not set (stays null = "never enqueued" state). Tests that need to
   * verify enqueue behavior pass a mock enqueue function.
   */
  r.post("/", "member", async (c) => {
    const parsed = createKbEntrySchema.safeParse(c.var.body);
    if (!parsed.success) {
      return validationError(c, parsed.error.issues);
    }

    const body = parsed.data;
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const enqueue = c.var.enqueue;

    const [inserted] = await db
      .insert(kbEntries)
      .values({
        tenantId,
        title: body.title,
        content: body.content,
        contentType: body.content_type ?? "markdown",
        source: body.source ?? "manual",
        sourceUrl: body.source_url ?? null,
        tags: body.tags ?? null,
        // Set embedding_status = 'pending' when we have an enqueue function,
        // so a crash after INSERT but before boss.send leaves a detectable orphan.
        // When enqueue is absent (tests), status stays null = "never enqueued".
        ...(enqueue ? { embeddingStatus: "pending" } : {}),
        isActive: body.is_active ?? true,
      } as any)
      .returning();

    if (enqueue && inserted) {
      await enqueue(
        QUEUE.KB_EMBED,
        { kb_entry_id: inserted.id, tenant_id: tenantId },
        {
          singletonKey: inserted.id,
          expireInMinutes: 10,
          retryLimit: 3,
          retryDelay: 60,
        },
      ).catch((err: unknown) => {
        // Enqueue failure: the entry is persisted with embedding_status = 'pending'.
        // The orphan repair scan (BACKLOG) will re-enqueue it. Log for visibility.
        console.warn(
          `[kb] failed to enqueue embedding job for entry ${inserted.id}:`,
          err,
        );
      });
    }

    return c.json(serializeEntry(inserted!), 201);
  });

  /**
   * GET /v1/kb
   * List knowledge base entries for the tenant with cursor-based pagination.
   *
   * Query parameters:
   *   ?limit=<n>           Page size (default: 50, max: 200).
   *   ?after=<cursor>      Cursor from previous page's next_cursor.
   *   ?include_inactive    Include inactive entries when set to "true".
   *
   * Response: { entries: EntryPreview[], next_cursor: string | null }
   * Content is returned as a truncated preview (first 300 chars).
   */
  r.get("/", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const query = c.req.query() as {
      limit?: string;
      after?: string;
      include_inactive?: string;
    };
    const includeInactive = query.include_inactive === "true";

    // Parse and clamp limit
    const rawLimit = parseInt(query.limit ?? "", 10);
    const limit = isNaN(rawLimit) || rawLimit < 1
      ? DEFAULT_PAGE_SIZE
      : Math.min(rawLimit, MAX_PAGE_SIZE);

    // Parse cursor
    let cursor: CursorPayload | null = null;
    if (query.after) {
      cursor = decodeCursor(query.after);
      // A malformed cursor is treated as no cursor (first page). Callers should
      // not construct cursors manually; this is defensive, not a security issue.
    }

    // Build WHERE conditions. Cursor uses (created_at, id) keyset ordering:
    //   (created_at > cursor.created_at)
    //   OR (created_at = cursor.created_at AND id > cursor.id)
    // This is correct for the ORDER BY (created_at ASC, id ASC) clause below.
    const tenantCondition = eq(kbEntries.tenantId, tenantId);
    const activeCondition = eq(kbEntries.isActive, true);

    // Fetch limit+1 to determine if there is a next page.
    const fetchLimit = limit + 1;

    let rows: (typeof kbEntries.$inferSelect)[];

    if (cursor) {
      const cursorCreatedAt = cursor.created_at; // ISO string (millisecond precision)
      const cursorId = cursor.id;               // UUID string

      // Cursor condition: (date_trunc('milliseconds', created_at), id) > (cursor_ts, cursor_id)
      //
      // JavaScript Date.toISOString() has millisecond precision; Postgres timestamptz
      // stores microseconds. Truncating the DB column to milliseconds before the
      // comparison ensures both sides of the ROW comparison have the same precision.
      // The ORDER BY clause below uses the same truncation expression so the ordering
      // the cursor was derived from and the cursor condition stay consistent.
      const cursorCondition = sql`
        ROW(date_trunc('milliseconds', ${kbEntries.createdAt}), ${kbEntries.id}) >
        ROW(${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
      `;

      rows = includeInactive
        ? await db
            .select()
            .from(kbEntries)
            .where(and(tenantCondition, cursorCondition))
            .orderBy(sql`date_trunc('milliseconds', ${kbEntries.createdAt}) ASC`, kbEntries.id)
            .limit(fetchLimit)
        : await db
            .select()
            .from(kbEntries)
            .where(and(tenantCondition, activeCondition, cursorCondition))
            .orderBy(sql`date_trunc('milliseconds', ${kbEntries.createdAt}) ASC`, kbEntries.id)
            .limit(fetchLimit);
    } else {
      rows = includeInactive
        ? await db
            .select()
            .from(kbEntries)
            .where(tenantCondition)
            .orderBy(sql`date_trunc('milliseconds', ${kbEntries.createdAt}) ASC`, kbEntries.id)
            .limit(fetchLimit)
        : await db
            .select()
            .from(kbEntries)
            .where(and(tenantCondition, activeCondition))
            .orderBy(sql`date_trunc('milliseconds', ${kbEntries.createdAt}) ASC`, kbEntries.id)
            .limit(fetchLimit);
    }

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasNextPage && lastRow
        ? encodeCursor(lastRow.createdAt, lastRow.id)
        : null;

    return c.json({
      entries: pageRows.map(serializeEntryPreview),
      next_cursor: nextCursor,
    });
  });

  /**
   * GET /v1/kb/:id
   * Get a single KB entry with full content.
   * Returns 404 if not found or owned by another tenant.
   */
  r.get("/:id", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const rows = await db
      .select()
      .from(kbEntries)
      .where(
        and(eq(kbEntries.id, c.req.param("id")!), eq(kbEntries.tenantId, tenantId)),
      )
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "Knowledge base entry not found." }, 404);
    }

    return c.json(serializeEntry(rows[0]!));
  });

  /**
   * PATCH /v1/kb/:id
   * Partial update. Only supplied fields are written; unset fields are preserved.
   * The embedding column is never updated by this route.
   *
   * Gap 2 fix: when content changes, embedding_status is reset to 'pending'
   * in the same UPDATE so the state is immediately operator-visible.
   *
   * Gap 3 note: same sequential (non-atomic) approach as POST. See POST comment.
   * Tag-only or non-content updates do not touch embedding_status.
   */
  r.patch(
    "/:id",
    "member",
    async (c) => {
      const parsed = updateKbEntrySchema.safeParse(c.var.body);
      if (!parsed.success) {
        return validationError(c, parsed.error.issues);
      }

      const body = parsed.data;
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;
      const enqueue = c.var.enqueue;
      const id = c.req.param("id")!;

      // Verify ownership
      const rows = await db
        .select()
        .from(kbEntries)
        .where(
          and(eq(kbEntries.id, id), eq(kbEntries.tenantId, tenantId)),
        )
        .limit(1);

      if (rows.length === 0) {
        return c.json({ error: "Knowledge base entry not found." }, 404);
      }

      // Build SET clause from only the supplied fields
      const setClauses: Record<string, unknown> = {
        updatedAt: new Date(),
      };

      if (body.title !== undefined)        setClauses.title = body.title;
      if (body.content !== undefined)      setClauses.content = body.content;
      if (body.content_type !== undefined) setClauses.contentType = body.content_type;
      if (body.source !== undefined)       setClauses.source = body.source;
      if (body.source_url !== undefined)   setClauses.sourceUrl = body.source_url;
      if (body.tags !== undefined)         setClauses.tags = body.tags;
      if (body.is_active !== undefined)    setClauses.isActive = body.is_active;

      const contentChanged = body.content !== undefined;

      // When content changes and enqueue is available, reset embedding_status
      // to 'pending' in the UPDATE so the state is correct even if the process
      // crashes after UPDATE but before boss.send.
      if (contentChanged && enqueue) {
        setClauses.embeddingStatus = "pending";
        setClauses.embeddingError = null;
      }

      const [updated] = await db
        .update(kbEntries)
        .set(setClauses as any)
        .where(
          and(eq(kbEntries.id, id), eq(kbEntries.tenantId, tenantId)),
        )
        .returning();

      // Enqueue re-embedding only when content changed.
      if (contentChanged && enqueue && updated) {
        await enqueue(
          QUEUE.KB_EMBED,
          { kb_entry_id: updated.id, tenant_id: tenantId },
          {
            singletonKey: updated.id,
            expireInMinutes: 10,
            retryLimit: 3,
            retryDelay: 60,
          },
        ).catch((err: unknown) => {
          console.warn(
            `[kb] failed to enqueue re-embedding job for entry ${updated.id}:`,
            err,
          );
        });
      }

      return c.json(serializeEntry(updated!));
    },
  );

  /**
   * DELETE /v1/kb/:id
   * Hard delete. Returns 200 with the deleted entry on success.
   * Returns 404 if the entry does not exist for this tenant.
   */
  r.delete("/:id", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const id = c.req.param("id")!;

    const rows = await db
      .select()
      .from(kbEntries)
      .where(
        and(eq(kbEntries.id, id), eq(kbEntries.tenantId, tenantId)),
      )
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "Knowledge base entry not found." }, 404);
    }

    await db
      .delete(kbEntries)
      .where(
        and(eq(kbEntries.id, id), eq(kbEntries.tenantId, tenantId)),
      );

    return c.json(serializeEntry(rows[0]!));
  });

  /**
   * POST /v1/kb/re-embed
   * Bulk re-embed action for operator recovery.
   *
   * Re-enqueues entries for the tenant that need embedding. This is the correct
   * recovery path after a credential rotation, model change, or any configuration
   * fix that affected multiple entries.
   *
   * Qualifying entries (idempotency + orphan recovery):
   *   embedding IS NULL AND (
   *     embedding_status IS NULL           - never enqueued
   *     OR embedding_status = 'failed'     - permanent failure
   *     OR (embedding_status = 'pending'   - stale pending = likely orphan
   *         AND updated_at < now() - 15 min)
   *   )
   *
   * The stale-pending rule recovers orphans: entries set to 'pending' by a
   * prior POST /v1/kb call where the process died before boss.send() completed.
   * A live job expires in expireInMinutes:10; after 15 minutes, no live job
   * can be in flight for that entry. See RE_EMBED_ORPHAN_THRESHOLD_MINUTES.
   *
   * Idempotency: a second call within 15 minutes finds recently-set 'pending'
   * entries excluded (live jobs assumed). A second call after 15 minutes picks
   * up any orphans the first call left behind.
   *
   * Bound: at most RE_EMBED_BATCH_CAP entries per call. The response includes
   * remaining so the operator knows when another call is needed.
   *
   * Returns 202 with { enqueued, remaining, total_qualifying }.
   * Returns 503 if the job queue is not available.
   */
  r.post("/re-embed", "member", async (c) => {
    const enqueue = c.var.enqueue;
    if (!enqueue) {
      return c.json({ error: "Job queue is not available." }, 503);
    }

    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    // Count ALL qualifying entries (for the 'remaining' response field).
    //
    // Qualifying condition (idempotency + orphan recovery):
    //   embedding IS NULL
    //   AND (
    //     embedding_status IS NULL                 -- never enqueued
    //     OR embedding_status = 'failed'           -- permanent failure, fix and retry
    //     OR (embedding_status = 'pending'         -- stale pending = likely orphan
    //         AND updated_at < now() - 15 min)     --   (process died before boss.send())
    //   )
    //
    // A 'pending' entry updated within the last 15 minutes is excluded: a live job
    // is assumed. An expireInMinutes:10 job cannot remain active past 10 minutes, so
    // anything still pending at 15 minutes has either orphaned or will self-expire.
    // See RE_EMBED_ORPHAN_THRESHOLD_MINUTES for the full rationale and failure modes.
    const orphanThreshold = `now() - interval '${RE_EMBED_ORPHAN_THRESHOLD_MINUTES} minutes'`;

    const allQualifying = await db
      .select({ id: kbEntries.id })
      .from(kbEntries)
      .where(
        and(
          eq(kbEntries.tenantId, tenantId),
          sql`${kbEntries.embedding} IS NULL`,
          sql`(
            ${kbEntries.embeddingStatus as any} IS NULL
            OR ${kbEntries.embeddingStatus as any} = 'failed'
            OR (${kbEntries.embeddingStatus as any} = 'pending'
                AND ${kbEntries.updatedAt} < ${sql.raw(orphanThreshold)})
          )`,
        ),
      );

    const totalQualifying = allQualifying.length;

    if (totalQualifying === 0) {
      return c.json({ enqueued: 0, remaining: 0, total_qualifying: 0, message: "No entries require re-embedding." }, 202);
    }

    // Apply the per-call cap.
    const batch = allQualifying.slice(0, RE_EMBED_BATCH_CAP);
    const remaining = totalQualifying - batch.length;
    const ids = batch.map((r) => r.id);

    // Reset embedding_status to 'pending' and clear embedding_error for this batch.
    await db
      .update(kbEntries)
      .set({
        embeddingStatus: "pending",
        embeddingError: null,
        updatedAt: new Date(),
      } as any)
      .where(
        and(
          eq(kbEntries.tenantId, tenantId),
          sql`id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])`,
        ),
      );

    // Enqueue a job for each entry in the batch.
    // Failures are logged but do not abort the remaining enqueues.
    let enqueued = 0;
    for (const { id } of batch) {
      try {
        await enqueue(
          QUEUE.KB_EMBED,
          { kb_entry_id: id, tenant_id: tenantId },
          {
            singletonKey: id,
            expireInMinutes: 10,
            retryLimit: 3,
            retryDelay: 60,
          },
        );
        enqueued++;
      } catch (err) {
        console.warn(
          `[kb] re-embed: failed to enqueue job for entry ${id}:`,
          err,
        );
      }
    }

    return c.json({
      enqueued,
      remaining,
      total_qualifying: totalQualifying,
      message:
        remaining > 0
          ? `Re-embedding enqueued for ${enqueued} entries. Call again to process ${remaining} more.`
          : `Re-embedding enqueued for ${enqueued} entries.`,
    }, 202);
  });
  return r.app;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/**
 * Map a DB row to the full single-entry API response shape.
 * Renames camelCase DB columns to snake_case for the wire format.
 * The embedding column is excluded: it is a large vector with no client-side
 * use case and would bloat every response significantly.
 * embedding_status and embedding_error are included so operators can determine
 * which entries are pending, failed, or never enqueued.
 */
function serializeEntry(row: typeof kbEntries.$inferSelect) {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    title: row.title,
    content: row.content,
    content_type: row.contentType,
    source: row.source,
    source_url: row.sourceUrl,
    tags: row.tags,
    embedding_status: (row as any).embeddingStatus ?? null,
    embedding_error: (row as any).embeddingError ?? null,
    is_active: row.isActive,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * Map a DB row to the list preview API response shape.
 * Returns content_preview (first 300 characters) instead of full content.
 * Used only by the paginated GET /v1/kb list endpoint.
 */
function serializeEntryPreview(row: typeof kbEntries.$inferSelect) {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    title: row.title,
    content_preview: makePreview(row.content),
    content_type: row.contentType,
    source: row.source,
    source_url: row.sourceUrl,
    tags: row.tags,
    embedding_status: (row as any).embeddingStatus ?? null,
    is_active: row.isActive,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}
