/**
 * Contact routes (People).
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * They are registered under the /v1 prefix inside the authenticated scope in
 * app.ts, which enforces request.tenant !== null before any route handler runs.
 *
 * Endpoints:
 *   GET /v1/contacts              list contacts (cursor-paginated; search + filters)
 *   GET /v1/contacts/:id          one contact: profile, flow memberships, suppression
 *   GET /v1/contacts/:id/timeline merged event/transition/message timeline (cursor-paginated)
 *
 * Tenant isolation: enforced in every WHERE clause. A contact that exists but
 * belongs to another tenant returns 404 (not 403), matching flows/kb.
 *
 * Pagination: cursor convention shared with GET /v1/kb, GET /v1/messages and
 * GET /v1/suppressions: opaque base64url JSON cursor, response shape
 * { <items>, next_cursor: string | null }, keyset on (created_at, id).
 * Both the list and the timeline order DESC (newest first). The cursor
 * payload and response shapes are identical to the ASC routes.
 *
 * Timeline as one endpoint: the person screen needs one ordered sequence
 * across events, lifecycle_transitions and lifecycle_messages. Merging in
 * SQL costs three bounded index-ranged scans plus a sort of at most
 * 3 * (limit + 1) rows; merging in the client would take three round trips
 * and still could not paginate a merged sequence correctly without
 * over-fetching every source. One endpoint, one cursor.
 *
 * Index notes (added in migration 0018):
 *   - list cursor keyset is served by idx_contacts_tenant_created
 *     (tenant_id, created_at, id).
 *   - the timeline's transitions branch uses idx_transitions_contact
 *     (contact_id, transitioned_at DESC).
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  resolveLifecycleConfig,
  tenureBucketRange,
  recencyBucketRange,
  RETENTION_TENURE_BUCKETS,
  RETENTION_RECENCY_BUCKETS,
  type LifecycleConfig,
} from "@claros/core";
import type { Db } from "../plugins/db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Lifecycle states and engagement depths, mirrored from
 * packages/core/src/lifecycle/states.ts and engagement-depth.ts. Duplicated
 * here because core is not an api dependency for enums the wire already owns;
 * the values are the contract, the import would be plumbing.
 *
 * Retention-grid buckets are the exception: their day ranges derive from the
 * tenant's lifecycle config, so the filter below imports the same core bucket
 * functions the grid read model and segment enrollment use - a People filter
 * and a grid cell must be the same set by construction. */
const LIFECYCLE_STATES = [
  "signed_up",
  "activated",
  "engaged",
  "at_risk",
  "dormant",
  "churned",
  "resurrected",
] as const;

const ENGAGEMENT_DEPTHS = ["power", "regular", "casual", "minimal"] as const;

// ---------------------------------------------------------------------------
// Cursor helpers (same convention as messages.ts / kb.ts)
// ---------------------------------------------------------------------------

interface CursorPayload {
  created_at: string;
  id: string;
}

function encodeCursor(createdAt: Date | string | null | undefined, id: string): string {
  const ts = createdAt instanceof Date
    ? createdAt.toISOString()
    : (createdAt ?? new Date(0).toISOString());
  const payload: CursorPayload = { created_at: ts, id };
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
// Query validation
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  limit: z.string().optional(),
  after: z.string().optional(),
  lifecycle_state: z.enum(LIFECYCLE_STATES).optional(),
  engagement_depth: z.enum(ENGAGEMENT_DEPTHS).optional(),
  tenure_bucket: z.enum(RETENTION_TENURE_BUCKETS).optional(),
  recency_bucket: z.enum(RETENTION_RECENCY_BUCKETS).optional(),
  search: z.string().max(200).optional(),
});

function validationError(reply: any, issues: z.ZodIssue[]) {
  reply.status(400);
  return {
    error: "Validation failed",
    issues: issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

function clampLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  if (isNaN(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const contactsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /v1/contacts
   *
   * List contacts for the tenant, cursor-paginated DESC on (created_at, id):
 * newest contacts first, which is what a People screen is for. The cursor
 * shape matches the other paginated routes; only the direction differs.
   *
   * Query params:
   *   ?limit=<n>              default 50, max 200
   *   ?after=<cursor>         opaque cursor from previous page's next_cursor
   *   ?lifecycle_state=<s>    exact match on the seven lifecycle states
   *   ?engagement_depth=<d>   exact match on power|regular|casual|minimal
   *   ?tenure_bucket=<t>      retention-grid tenure bucket (new|growing|established|loyal)
   *   ?recency_bucket=<r>     retention-grid recency bucket (active|cooling|idle|dormant)
   *   ?search=<text>          case-insensitive substring on email, name, external_id
   *
   * The bucket filters apply the same core day-range functions as the
   * retention-grid read model, so /people?tenure_bucket=X&recency_bucket=Y
   * lists exactly the contacts sitting in that grid cell.
   *
   * Response: { contacts: [...], next_cursor: string | null }
   */
  app.get<{
    Querystring: {
      limit?: string;
      after?: string;
      lifecycle_state?: string;
      engagement_depth?: string;
      tenure_bucket?: string;
      recency_bucket?: string;
      search?: string;
    };
  }>("/", { config: { minRole: "member" } }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const limit = clampLimit(parsed.data.limit);
    const fetchLimit = limit + 1;
    const cursor = parsed.data.after ? decodeCursor(parsed.data.after) : null;
    const state = parsed.data.lifecycle_state ?? null;
    const depth = parsed.data.engagement_depth ?? null;
    const search = parsed.data.search?.trim() ? `%${parsed.data.search.trim()}%` : null;
    // DESC keyset: newest contacts first. Rows strictly older than the cursor.
    const cursorClause = cursor
      ? sql`AND ROW(created_at, id) < ROW(${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
      : sql``;

    // Retention-grid bucket filters resolve to day ranges via the tenant's
    // lifecycle config (recency thresholds depend on natural_frequency_days).
    // Config is loaded only when a bucket filter is present.
    let tenureMin: number | null = null;
    let tenureMax: number | null = null;
    let recencyMin: number | null = null;
    let recencyMax: number | null = null;
    if (parsed.data.tenure_bucket || parsed.data.recency_bucket) {
      const tenantRows = await db.execute<{ settings: unknown }>(sql`
        SELECT settings FROM tenants WHERE id = ${tenantId}
      `);
      const settings = tenantRows.rows[0]?.settings as
        | Record<string, unknown>
        | null
        | undefined;
      const config: LifecycleConfig = resolveLifecycleConfig(
        settings?.lifecycle as Partial<LifecycleConfig> | null | undefined,
      );
      if (parsed.data.tenure_bucket) {
        const r = tenureBucketRange(parsed.data.tenure_bucket);
        tenureMin = r.minDays;
        tenureMax = r.maxDays;
      }
      if (parsed.data.recency_bucket) {
        const r = recencyBucketRange(
          parsed.data.recency_bucket,
          config.natural_frequency_days,
        );
        recencyMin = r.minDays;
        recencyMax = r.maxDays;
      }
    }

    const rows = (
      await db.execute<{
        id: string;
        tenant_id: string;
        external_id: string;
        email: string | null;
        name: string | null;
        company: string | null;
        lifecycle_state: string;
        engagement_depth: string | null;
        payment_status: string | null;
        last_seen_at: string | null;
        created_at: string;
      }>(sql`
        SELECT id, tenant_id, external_id, email, name, company,
               lifecycle_state, engagement_depth, payment_status,
               last_seen_at, created_at
        FROM contacts
        WHERE tenant_id = ${tenantId}
          AND (${state}::text IS NULL OR lifecycle_state = ${state})
          AND (${depth}::text IS NULL OR engagement_depth = ${depth})
          AND (${search}::text IS NULL OR
               email ILIKE ${search} OR
               name ILIKE ${search} OR
               external_id ILIKE ${search})
          AND (${tenureMin}::int IS NULL OR first_seen_at <= now() - make_interval(days => ${tenureMin}))
          AND (${tenureMax}::int IS NULL OR first_seen_at > now() - make_interval(days => ${tenureMax}))
          AND (${recencyMin}::int IS NULL OR last_seen_at <= now() - make_interval(days => ${recencyMin}))
          AND (${recencyMax}::int IS NULL OR last_seen_at > now() - make_interval(days => ${recencyMax}))
          ${cursorClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ${fetchLimit}
      `)
    ).rows;

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor = hasNextPage && lastRow
      ? encodeCursor(lastRow.created_at, lastRow.id)
      : null;

    return { contacts: pageRows, next_cursor: nextCursor };
  });

  /**
   * GET /v1/contacts/:id
   *
   * One contact: profile fields, flow memberships (with flow names), and
   * suppression state for their email. 404 if not found or owned by another
   * tenant.
   *
   * Response: { contact: {...}, memberships: [...], suppression: {...} | null }
   */
  app.get<{ Params: { id: string } }>("/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    if (!isUuid(request.params.id)) {
      reply.status(404);
      return { error: "Contact not found." };
    }

    const contactRows = (
      await db.execute<Record<string, unknown>>(sql`
        SELECT id, tenant_id, external_id, email, name, company, properties,
               lifecycle_state, engagement_depth, payment_status,
               first_seen_at, last_seen_at, activated_at, created_at
        FROM contacts
        WHERE tenant_id = ${tenantId} AND id = ${request.params.id}::uuid
        LIMIT 1
      `)
    ).rows;

    if (contactRows.length === 0) {
      reply.status(404);
      return { error: "Contact not found." };
    }

    const contact = contactRows[0]!;

    const memberships = (
      await db.execute<Record<string, unknown>>(sql`
        SELECT m.id, m.flow_id, f.name AS flow_name, m.status, m.current_step,
               m.entered_at, m.completed_at, m.exited_at, m.exit_reason
        FROM flow_memberships m
        JOIN flows f ON f.id = m.flow_id AND f.tenant_id = ${tenantId}
        WHERE m.tenant_id = ${tenantId} AND m.contact_id = ${request.params.id}::uuid
        ORDER BY m.entered_at DESC
      `)
    ).rows;

    let suppression: Record<string, unknown> | null = null;
    if (typeof contact.email === "string" && contact.email.length > 0) {
      const supRows = (
        await db.execute<Record<string, unknown>>(sql`
          SELECT id, reason, source, created_at
          FROM suppressions
          WHERE tenant_id = ${tenantId} AND lower(email) = lower(${contact.email})
          LIMIT 1
        `)
      ).rows;
      suppression = supRows[0] ?? null;
    }

    return { contact, memberships, suppression };
  });

  /**
   * GET /v1/contacts/:id/timeline
   *
   * Merged timeline across events, lifecycle_transitions and
   * lifecycle_messages, ordered DESC (newest first), cursor-paginated on
   * (occurred_at, id). Each branch is independently limited so each uses its
   * own index range; the outer query sorts at most 3 * (limit + 1) rows.
   *
   * Query params: ?limit=<n> (default 50, max 200), ?after=<cursor>
   * Response: { items: [...], next_cursor: string | null }
   *
   * Item shapes:
   *   { kind: "event",      id, occurred_at, event_type, event_name, properties, context }
   *   { kind: "transition", id, occurred_at, from_state, to_state, metadata }
   *   { kind: "message",    id, occurred_at, subject, status, feedback,
   *     flow_id, flow_name, flow_step_order }
   */
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; after?: string };
  }>("/:id/timeline", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    if (!isUuid(request.params.id)) {
      reply.status(404);
      return { error: "Contact not found." };
    }

    // Existence check with tenant scoping; the timeline of another tenant's
    // contact is as absent as the contact.
    const exists = (
      await db.execute<{ id: string }>(sql`
        SELECT id FROM contacts
        WHERE tenant_id = ${tenantId} AND id = ${request.params.id}::uuid
        LIMIT 1
      `)
    ).rows;
    if (exists.length === 0) {
      reply.status(404);
      return { error: "Contact not found." };
    }

    const limit = clampLimit(request.query.limit);
    const fetchLimit = limit + 1;
    const cursor = request.query.after ? decodeCursor(request.query.after) : null;
    const contactId = request.params.id;
    // DESC keyset: rows strictly older than the cursor, applied inside each
    // branch so the branch LIMIT cannot cut off rows a later page needs.
    const eventCursor = cursor
      ? sql`AND ROW(e."timestamp", e.id) < ROW(${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
      : sql``;
    const transitionCursor = cursor
      ? sql`AND ROW(t.transitioned_at, t.id) < ROW(${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
      : sql``;
    const messageCursor = cursor
      ? sql`AND ROW(COALESCE(m.sent_at, m.created_at), m.id) < ROW(${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
      : sql``;

    const rows = (
      await db.execute<Record<string, unknown>>(sql`
        SELECT * FROM (
          (
            SELECT 'event' AS kind, e.id, e."timestamp" AS occurred_at,
                   e.type AS event_type, e.event_name, e.properties,
                   NULL::text AS from_state, NULL::text AS to_state,
                   NULL::text AS subject, NULL::text AS status,
                   NULL::text AS feedback, NULL::uuid AS flow_id,
                   NULL::text AS flow_name, NULL::integer AS flow_step_order,
                   e.context, NULL::jsonb AS metadata
            FROM events e
            WHERE e.tenant_id = ${tenantId} AND e.contact_id = ${contactId}::uuid
            ${eventCursor}
            ORDER BY e."timestamp" DESC, e.id DESC
            LIMIT ${fetchLimit}
          )
          UNION ALL
          (
            SELECT 'transition', t.id, t.transitioned_at,
                   NULL, NULL, NULL,
                   t.from_state, t.to_state,
                   NULL, NULL, NULL, NULL, NULL, NULL,
                   NULL::jsonb, t.metadata
            FROM lifecycle_transitions t
            WHERE t.tenant_id = ${tenantId} AND t.contact_id = ${contactId}::uuid
            ${transitionCursor}
            ORDER BY t.transitioned_at DESC, t.id DESC
            LIMIT ${fetchLimit}
          )
          UNION ALL
          (
            SELECT 'message', m.id, COALESCE(m.sent_at, m.created_at),
                   NULL, NULL, NULL,
                   NULL, NULL,
                   m.subject, m.status, m.feedback, m.flow_id, f.name, m.flow_step_order,
                   NULL::jsonb, NULL::jsonb
            FROM lifecycle_messages m
            JOIN flows f ON f.id = m.flow_id AND f.tenant_id = ${tenantId}
            WHERE m.tenant_id = ${tenantId} AND m.contact_id = ${contactId}::uuid
            ${messageCursor}
            ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
            LIMIT ${fetchLimit}
          )
        ) merged
        ORDER BY merged.occurred_at DESC, merged.id DESC
        LIMIT ${fetchLimit}
      `)
    ).rows;

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1] as
      | { occurred_at: string; id: string }
      | undefined;
    const nextCursor = hasNextPage && lastRow
      ? encodeCursor(lastRow.occurred_at, lastRow.id)
      : null;

    return { items: pageRows, next_cursor: nextCursor };
  });
};

export default contactsRoutes;
