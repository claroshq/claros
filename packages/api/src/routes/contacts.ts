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
 *   GET /v1/contacts/:id/notes    the team's notes about the contact, newest first
 *   POST /v1/contacts/:id/notes   add a note { "body": "..." }
 *   DELETE /v1/contacts/:id/notes/:noteId  delete a note
 *
 * Notes are for the team only: the engine never reads them and they never
 * reach the LLM. Session only (no admin key scope).
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
import { z } from "zod";
import { storeFor } from "@claros/store";
import {
  resolveLifecycleConfig,
  tenureBucketRange,
  recencyBucketRange,
  RETENTION_TENURE_BUCKETS,
  RETENTION_RECENCY_BUCKETS,
  type LifecycleConfig,
} from "@claros/core";
import type { Db } from "../plugins/db.js";
import type { AppContext } from "../http/env.js";
import { RoleRouter, allowAdminKey, validatedBody } from "../http/router.js";
import { validateBody } from "../http/validate.js";
import type { ContactNoteRow } from "@claros/store";

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

function validationError(c: AppContext, issues: z.ZodIssue[]) {
  return c.json(
    {
      error: "Validation failed",
      issues: issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    },
    400,
  );
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
// Router
// ---------------------------------------------------------------------------

export default function contactsRoutes() {
  const router = new RoleRouter();
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
  router.get("/", "member", allowAdminKey("contacts:read"), async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.issues);
    }

    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const limit = clampLimit(parsed.data.limit);
    const fetchLimit = limit + 1;
    const cursor = parsed.data.after ? decodeCursor(parsed.data.after) : null;
    const state = parsed.data.lifecycle_state ?? null;
    const depth = parsed.data.engagement_depth ?? null;
    const search = parsed.data.search?.trim() ? `%${parsed.data.search.trim()}%` : null;

    // Retention-grid bucket filters resolve to day ranges via the tenant's
    // lifecycle config (recency thresholds depend on natural_frequency_days).
    // Config is loaded only when a bucket filter is present.
    let tenureMin: number | null = null;
    let tenureMax: number | null = null;
    let recencyMin: number | null = null;
    let recencyMax: number | null = null;
    if (parsed.data.tenure_bucket || parsed.data.recency_bucket) {
      const settings = (await storeFor(db).apiContacts.getTenantSettings({ tenantId })) as
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

    const rows = await storeFor(db).apiContacts.listContacts({
      tenantId,
      filter: {
        lifecycleState: state,
        engagementDepth: depth,
        searchPattern: search,
        tenureMinDays: tenureMin,
        tenureMaxDays: tenureMax,
        recencyMinDays: recencyMin,
        recencyMaxDays: recencyMax,
        // DESC keyset: newest contacts first. Rows strictly older than the cursor.
        before: cursor ? { createdAt: cursor.created_at, id: cursor.id } : null,
      },
      limit: fetchLimit,
    });

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor = hasNextPage && lastRow
      ? encodeCursor(lastRow.created_at, lastRow.id)
      : null;

    return c.json({ contacts: pageRows, next_cursor: nextCursor });
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
  router.get("/:id", "member", allowAdminKey("contacts:read"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const id = c.req.param("id")!;
    if (!isUuid(id)) {
      return c.json({ error: "Contact not found." }, 404);
    }

    const contact = await storeFor(db).apiContacts.getContact({ tenantId, contactId: id });

    if (contact === null) {
      return c.json({ error: "Contact not found." }, 404);
    }

    const memberships = await storeFor(db).apiContacts.listContactMemberships({ tenantId, contactId: id });

    let suppression: Record<string, unknown> | null = null;
    if (typeof contact.email === "string" && contact.email.length > 0) {
      suppression = await storeFor(db).apiContacts.findSuppression({ tenantId, email: contact.email });
    }

    // Topic statuses (G8a): every topic of the product with the contact's
    // explicit status, or the topic default ("default": true) when none is set.
    const topics = (await storeFor(db).apiContacts.listContactTopics({ tenantId, contactId: id })).map(topicJson);

    return c.json({ contact, memberships, suppression, topics });
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
  router.get("/:id/timeline", "member", allowAdminKey("contacts:read"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const id = c.req.param("id")!;
    if (!isUuid(id)) {
      return c.json({ error: "Contact not found." }, 404);
    }

    // Existence check with tenant scoping; the timeline of another tenant's
    // contact is as absent as the contact.
    const exists = await storeFor(db).apiContacts.contactExists({ tenantId, contactId: id });
    if (!exists) {
      return c.json({ error: "Contact not found." }, 404);
    }

    const query = c.req.query();
    const limit = clampLimit(query.limit);
    const fetchLimit = limit + 1;
    const cursor = query.after ? decodeCursor(query.after) : null;
    const contactId = id;
    // DESC keyset: rows strictly older than the cursor (applied per branch).
    const rows = await storeFor(db).apiContacts.listContactTimeline({
      tenantId,
      contactId,
      before: cursor ? { occurredAt: cursor.created_at, id: cursor.id } : null,
      limit: fetchLimit,
    });

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1] as
      | { occurred_at: string; id: string }
      | undefined;
    const nextCursor = hasNextPage && lastRow
      ? encodeCursor(lastRow.occurred_at, lastRow.id)
      : null;

    return c.json({ items: pageRows, next_cursor: nextCursor });
  });
  /**
   * DELETE /v1/contacts/:ref (G12)
   *
   * Erase a contact of the product by external_id (or contact id): its
   * events, memberships, messages and topic statuses. Suppressions stay.
   * Owner session or an admin key with the contacts:delete scope.
   */
  router.delete("/:id", "owner", allowAdminKey("contacts:delete"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const ref = decodeURIComponent(c.req.param("id")!);
    const contact = await storeFor(db).apiContacts.findContactByRef({ tenantId, ref });
    if (!contact) return c.json({ error: "Contact not found." }, 404);
    await storeFor(db).apiContacts.eraseContact({ tenantId, contactId: contact.id });
    return c.json({ erased: true, id: contact.id, external_id: contact.externalId });
  });

  /**
   * POST /v1/contacts/:ref/exclude (G20)
   *
   * Exclude a person from lifecycle mail: a manual suppression of the
   * contact's email and every not-yet-sent message cancelled, atomically.
   * Undo with DELETE /v1/suppressions/:email (cancelled messages stay).
   */
  router.post("/:id/exclude", "member", allowAdminKey("messages"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const ref = decodeURIComponent(c.req.param("id")!);
    const contact = await storeFor(db).apiContacts.findContactByRef({ tenantId, ref });
    if (!contact) return c.json({ error: "Contact not found." }, 404);
    const out = await storeFor(db).apiContacts.excludeContact({
      tenantId,
      contactId: contact.id,
      email: contact.email,
      now: new Date(),
    });
    return c.json({ id: contact.id, external_id: contact.externalId, suppressed: out.suppressed, cancelled: out.cancelled });
  });

  /**
   * PUT /v1/contacts/:id/topics - set the contact's topic subscriptions from
   * the dashboard, keyed by topic slug: { "topics": { "product-news": false } }.
   * Recorded with source "admin"; a change of effective status emits
   * contact.subscribed or contact.unsubscribed (scope "topic", source
   * "admin"). Transactional topics have no subscription (400). Product-wide
   * unsubscribes stay on the suppression list.
   */
  router.put("/:id/topics", "member", validatedBody(topicsBodySchema), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const v = validateBody(c, topicsBodySchema);
    if (!v.ok) return v.response;
    const contactId = c.req.param("id")!;
    if (!isUuid(contactId)) return c.json({ error: "Contact not found." }, 404);
    const contact = await storeFor(db).apiContacts.getContact({ tenantId, contactId });
    if (!contact) return c.json({ error: "Contact not found." }, 404);

    const before = await storeFor(db).apiContacts.listContactTopics({ tenantId, contactId });
    const wanted = Object.entries(v.value.topics);
    if (wanted.length === 0) return c.json({ error: "Name at least one topic." }, 400);
    const statuses: Array<{ topicId: string; status: "subscribed" | "unsubscribed" }> = [];
    const outbox: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const email = typeof contact.email === "string" ? contact.email : null;
    for (const [slug, on] of wanted) {
      const t = before.find((x) => x.slug === slug);
      if (!t) return c.json({ error: `Unknown topic "${slug}".` }, 400);
      if (t.kind === "transactional") return c.json({ error: `"${slug}" is a transactional topic; it has no subscription.` }, 400);
      const next = on ? "subscribed" : "unsubscribed";
      statuses.push({ topicId: t.topicId, status: next });
      const was = t.status ?? (t.defaultSubscribed ? "subscribed" : "unsubscribed");
      if (was !== next) {
        outbox.push({
          event: next === "subscribed" ? "contact.subscribed" : "contact.unsubscribed",
          payload: { contact_id: contactId, email, scope: "topic", topic: slug, topic_id: t.topicId, source: "admin" },
        });
      }
    }
    await storeFor(db).apiUnsubscribe.setContactTopicStatuses({ tenantId, contactId, statuses, source: "admin", now: new Date(), outbox });
    const topics = (await storeFor(db).apiContacts.listContactTopics({ tenantId, contactId })).map(topicJson);
    return c.json({ topics });
  });

  /** GET /v1/contacts/:id/notes - the team's notes about the contact, newest first. */
  router.get("/:id/notes", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const contactId = c.req.param("id")!;
    if (!isUuid(contactId) || !(await storeFor(db).apiContacts.contactExists({ tenantId, contactId }))) {
      return c.json({ error: "Contact not found." }, 404);
    }
    const notes = await storeFor(db).apiContacts.listContactNotes({ tenantId, contactId });
    return c.json({ items: notes.map(noteJson) });
  });

  /** POST /v1/contacts/:id/notes - add a note { "body": "..." }. */
  router.post("/:id/notes", "member", validatedBody(noteBodySchema), async (c) => {
    const db: Db = c.var.db;
    const tenant = c.var.tenant!;
    const v = validateBody(c, noteBodySchema);
    if (!v.ok) return v.response;
    const body = v.value.body.trim();
    if (body.length === 0) return c.json({ error: "A note needs some text." }, 400);
    const note = await storeFor(db).apiContacts.addContactNote({
      tenantId: tenant.id,
      contactId: c.req.param("id")!,
      authorUserId: tenant.userId || null,
      body,
      now: new Date(),
    });
    if (!note) return c.json({ error: "Contact not found." }, 404);
    return c.json(noteJson(note), 201);
  });

  /** DELETE /v1/contacts/:id/notes/:noteId - delete a note. */
  router.delete("/:id/notes/:noteId", "member", async (c) => {
    const db: Db = c.var.db;
    const deleted = await storeFor(db).apiContacts.deleteContactNote({
      tenantId: c.var.tenant!.id,
      contactId: c.req.param("id")!,
      noteId: c.req.param("noteId")!,
    });
    if (!deleted) return c.json({ error: "Note not found." }, 404);
    return c.json({ deleted: true });
  });

  return router.app;
}

const NOTE_MAX_LENGTH = 5000;

/** PUT /v1/contacts/:id/topics body: topic slug -> subscribed. */
const topicsBodySchema = z.object({ topics: z.record(z.string(), z.boolean()) });

/** A topic status as GET /v1/contacts/:id and PUT .../topics return it. */
function topicJson(t: { topicId: string; slug: string; name: string; kind: string; status: string | null; defaultSubscribed: boolean; source: string | null; updatedAt: Date | null }) {
  return {
    topic_id: t.topicId,
    slug: t.slug,
    name: t.name,
    kind: t.kind,
    status: t.status ?? (t.defaultSubscribed ? "subscribed" : "unsubscribed"),
    default: t.status === null,
    source: t.source,
    updated_at: t.updatedAt,
  };
}

const noteBodySchema = z.object({
  body: z.string().max(NOTE_MAX_LENGTH, `A note is at most ${NOTE_MAX_LENGTH} characters.`),
});

function noteJson(n: ContactNoteRow) {
  return {
    id: n.id,
    body: n.body,
    created_at: n.createdAt.toISOString(),
    author: n.authorUserId ? { id: n.authorUserId, name: n.authorName, email: n.authorEmail } : null,
  };
}
