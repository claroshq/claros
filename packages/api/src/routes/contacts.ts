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
 * { <items>, next_cursor: string | null }. The timeline keysets on
 * (occurred_at, id) DESC. The list keysets on (sort key, id) for the sort
 * asked for (created_at DESC by default); its cursor carries the sort, and a
 * { created_at, id } cursor from before sorting still pages the default.
 *
 * Timeline as one endpoint: the person screen needs one ordered sequence
 * across events, lifecycle_transitions and lifecycle_messages. Merging in
 * SQL costs three bounded index-ranged scans plus a sort of at most
 * 3 * (limit + 1) rows; merging in the client would take three round trips
 * and still could not paginate a merged sequence correctly without
 * over-fetching every source. One endpoint, one cursor.
 *
 * Index notes (added in migration 0018):
 *   - the default list order is served by idx_contacts_tenant_created
 *     (tenant_id, created_at, id). The name, joined and last_seen sorts and
 *     the per-letter counts read the tenant's contacts without an index of
 *     their own, as search and the total already do.
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
  CONTACT_AUDIENCES,
  type LifecycleConfig,
  storedLifecycleState,
  withPublicStates,
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
  // gone_quiet is the name the API returns; churned (its old name) is still accepted.
  "gone_quiet",
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
// List cursor: (sort key, id) for any sort
// ---------------------------------------------------------------------------

const SORT_KEYS = ["created", "name", "joined", "last_seen"] as const;
type SortKey = (typeof SORT_KEYS)[number];
type SortOrder = "asc" | "desc";

/** Default direction per sort key: newest first for dates, A to Z for names. */
const DEFAULT_ORDER: Record<SortKey, SortOrder> = {
  created: "desc",
  name: "asc",
  joined: "desc",
  last_seen: "desc",
};

interface ListCursorPayload {
  s: SortKey;
  o: SortOrder;
  k: string | number;
  id: string;
}

function encodeListCursor(sort: SortKey, order: SortOrder, key: unknown, id: string): string {
  const k = key instanceof Date ? key.toISOString() : typeof key === "number" ? key : String(key);
  const payload: ListCursorPayload = { s: sort, o: order, k, id };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * The list cursor, or "invalid". A cursor from before sorting existed
 * ({ created_at, id }) still pages the default order (created, desc).
 */
function decodeListCursor(cursor: string): ListCursorPayload | "invalid" {
  try {
    const p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof p !== "object" || p === null || typeof p.id !== "string" || !isUuid(p.id)) return "invalid";
    // Timestamp keys must parse, so a tampered cursor never reaches a SQL cast.
    const isTime = (k: unknown) =>
      typeof k === "number" ? Number.isFinite(k) : typeof k === "string" && !Number.isNaN(Date.parse(k));
    if (typeof p.created_at === "string") {
      return isTime(p.created_at) ? { s: "created", o: "desc", k: p.created_at, id: p.id } : "invalid";
    }
    if (!(SORT_KEYS as readonly unknown[]).includes(p.s) || (p.o !== "asc" && p.o !== "desc")) return "invalid";
    const s = p.s as SortKey;
    if (s === "name" ? typeof p.k !== "string" : !isTime(p.k)) return "invalid";
    return { s, o: p.o, k: p.k as string | number, id: p.id };
  } catch {
    return "invalid";
  }
}

// ---------------------------------------------------------------------------
// Query validation
// ---------------------------------------------------------------------------

const PAYMENT_STATUSES = ["free", "trial", "paid", "past_due", "cancelled"] as const;

/** An ISO 8601 date (UTC midnight) or date-time, normalised to an ISO instant. */
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "Expected an ISO 8601 date or date-time")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Expected an ISO 8601 date or date-time")
  .transform((v) => new Date(v).toISOString());

const listQuerySchema = z.object({
  limit: z.string().optional(),
  after: z.string().optional(),
  lifecycle_state: z.enum(LIFECYCLE_STATES).optional(),
  engagement_depth: z.enum(ENGAGEMENT_DEPTHS).optional(),
  tenure_bucket: z.enum(RETENTION_TENURE_BUCKETS).optional(),
  recency_bucket: z.enum(RETENTION_RECENCY_BUCKETS).optional(),
  audience: z.enum(CONTACT_AUDIENCES).optional(),
  search: z.string().max(200).optional(),
  payment_status: z.enum(PAYMENT_STATUSES).optional(),
  letter: z
    .string()
    .regex(/^[a-zA-Z#]$/, "Expected one letter a-z, or #")
    .transform((v) => v.toLowerCase())
    .optional(),
  joined_after: instant.optional(),
  joined_before: instant.optional(),
  last_seen_after: instant.optional(),
  last_seen_before: instant.optional(),
  sort: z.enum(SORT_KEYS).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

/** Initials outside a-z count under "#", as the letter filter does. */
function letterOf(initial: string): string {
  return /^[a-z]$/.test(initial) ? initial : "#";
}

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
   * List contacts for the tenant, keyset-paginated. Without `sort` the order
   * is newest contacts first (created_at DESC, id DESC), as before sorting
   * existed.
   *
   * Query params:
   *   ?limit=<n>              default 50, max 200
   *   ?after=<cursor>         opaque cursor from previous page's next_cursor;
   *                           it belongs to the sort it came from (400 otherwise)
   *   ?sort=<key>             created (default) | name | joined | last_seen
   *   ?order=<dir>            asc | desc; default desc, name asc
   *   ?lifecycle_state=<s>    exact match on the seven lifecycle states (gone_quiet = churned)
   *   ?engagement_depth=<d>   exact match on power|regular|casual|minimal
   *   ?payment_status=<p>     exact match on free|trial|paid|past_due|cancelled
   *   ?letter=<l>             display name starts with a-z, or "#" for anything else
   *   ?joined_after=<iso>     joined (first seen, else created) at or after
   *   ?joined_before=<iso>    joined strictly before
   *   ?last_seen_after=<iso>  last seen at or after (never-seen contacts excluded)
   *   ?last_seen_before=<iso> last seen strictly before (never-seen contacts excluded)
   *   ?tenure_bucket=<t>      retention-grid tenure bucket (new|growing|established|loyal)
   *   ?recency_bucket=<r>     retention-grid recency bucket (active|cooling|idle|dormant)
   *   ?audience=<a>           all|paid|free: paid = payment_status paid or past_due,
   *                           free = every other value (the Lifecycle page split)
   *   ?search=<text>          case-insensitive substring on email, name, external_id
   *
   * The display name is the name, else the email, else the external id; the
   * `name` sort and the `letter` filter use it lowercased. Dates take an ISO
   * 8601 date (UTC midnight) or date-time.
   *
   * The bucket filters apply the same core day-range functions as the
   * retention-grid read model, so /people?tenure_bucket=X&recency_bucket=Y
   * lists exactly the contacts sitting in that grid cell.
   *
   * Response:
   *   { contacts: [...], next_cursor: string | null,
   *     total?: number, letters?: { [letter]: number } }
   *
   * First page only (no `after`): `total` is how many contacts match the
   * filters and search across all pages; `letters` counts the matches per
   * initial with every filter except `letter` applied, for an A-Z bar
   * (letters with no one are absent).
   */
  router.get("/", "member", allowAdminKey("contacts:read"), async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.issues);
    }

    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const q = parsed.data;
    const limit = clampLimit(q.limit);
    const fetchLimit = limit + 1;
    const sortKey: SortKey = q.sort ?? "created";
    const order: SortOrder = q.order ?? DEFAULT_ORDER[sortKey];

    const cursor = q.after ? decodeListCursor(q.after) : null;
    if (cursor !== null && cursor !== "invalid" && (cursor.s !== sortKey || cursor.o !== order)) {
      return c.json({ error: "The cursor belongs to another sort; start again without `after`." }, 400);
    }
    // An unreadable cursor starts from the first page, as it always has.
    const after = cursor !== null && cursor !== "invalid" ? { key: cursor.k, id: cursor.id } : null;
    const search = q.search?.trim() ? `%${q.search.trim()}%` : null;

    // Retention-grid bucket filters resolve to day ranges via the tenant's
    // lifecycle config (recency thresholds depend on natural_frequency_days).
    // Config is loaded only when a bucket filter is present.
    let tenureMin: number | null = null;
    let tenureMax: number | null = null;
    let recencyMin: number | null = null;
    let recencyMax: number | null = null;
    if (q.tenure_bucket || q.recency_bucket) {
      const settings = (await storeFor(db).apiContacts.getTenantSettings({ tenantId })) as
        | Record<string, unknown>
        | null
        | undefined;
      const config: LifecycleConfig = resolveLifecycleConfig(
        settings?.lifecycle as Partial<LifecycleConfig> | null | undefined,
      );
      if (q.tenure_bucket) {
        const r = tenureBucketRange(q.tenure_bucket);
        tenureMin = r.minDays;
        tenureMax = r.maxDays;
      }
      if (q.recency_bucket) {
        const r = recencyBucketRange(q.recency_bucket, config.natural_frequency_days);
        recencyMin = r.minDays;
        recencyMax = r.maxDays;
      }
    }

    const filter = {
      lifecycleState: q.lifecycle_state ? storedLifecycleState(q.lifecycle_state) : null,
      engagementDepth: q.engagement_depth ?? null,
      paymentStatus: q.payment_status ?? null,
      searchPattern: search,
      letter: q.letter ?? null,
      tenureMinDays: tenureMin,
      tenureMaxDays: tenureMax,
      recencyMinDays: recencyMin,
      recencyMaxDays: recencyMax,
      joinedAfter: q.joined_after ?? null,
      joinedBefore: q.joined_before ?? null,
      lastSeenAfter: q.last_seen_after ?? null,
      lastSeenBefore: q.last_seen_before ?? null,
      audience: q.audience ?? "all",
    };
    const store = storeFor(db).apiContacts;
    // Counts come with the first page only: later pages are "Load more" on
    // a list whose header and A-Z bar already have them.
    const [rows, initials] = await Promise.all([
      store.listContacts({ tenantId, filter, sort: { key: sortKey, order }, after, limit: fetchLimit }),
      q.after ? Promise.resolve(null) : store.countContactsByInitial({ tenantId, filter }),
    ]);

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor = hasNextPage && lastRow
      ? encodeListCursor(sortKey, order, lastRow.sort_key, lastRow.id)
      : null;
    const contacts = pageRows.map(({ sort_key: _key, ...row }) => withPublicStates(row, ["lifecycle_state"]));

    if (initials === null) {
      return c.json({ contacts, next_cursor: nextCursor });
    }
    const letters: Record<string, number> = {};
    for (const { initial, n } of initials) {
      const l = letterOf(initial);
      letters[l] = (letters[l] ?? 0) + n;
    }
    const total = filter.letter !== null
      ? (letters[filter.letter] ?? 0)
      : Object.values(letters).reduce((sum, n) => sum + n, 0);
    return c.json({ contacts, next_cursor: nextCursor, total, letters });
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

    return c.json({ contact: withPublicStates(contact, ["lifecycle_state"]), memberships, suppression, topics });
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

    return c.json({ items: pageRows.map((r) => withPublicStates(r, ["from_state", "to_state"])), next_cursor: nextCursor });
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
