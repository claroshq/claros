/**
 * Contact actions and lookups shared by the HTTP routes (routes/contacts.ts)
 * and the MCP tools (mcp/tools.ts).
 */
import { storeFor } from "@claros/store";
import { withPublicStates } from "@claros/core";
import type { ServiceContext } from "./messages.js";

export type ContactRef = { id: string; externalId: string; email: string | null };

/** A contact of the product by external_id, else by id (uuid), or null. */
export function findContact(ctx: Pick<ServiceContext, "db" | "tenant">, ref: string): Promise<ContactRef | null> {
  return storeFor(ctx.db).apiContacts.findContactByRef({ tenantId: ctx.tenant.id, ref });
}

/**
 * Exclude a person from lifecycle mail: a manual suppression of the
 * contact's email and every not-yet-sent message cancelled, atomically.
 * Null when the contact does not exist in this product.
 */
export async function excludeContact(
  ctx: Pick<ServiceContext, "db" | "tenant">,
  ref: string,
): Promise<{ id: string; external_id: string; suppressed: boolean; cancelled: string[] } | null> {
  const contact = await findContact(ctx, ref);
  if (!contact) return null;
  const out = await storeFor(ctx.db).apiContacts.excludeContact({
    tenantId: ctx.tenant.id,
    contactId: contact.id,
    email: contact.email,
    now: new Date(),
  });
  return { id: contact.id, external_id: contact.externalId, suppressed: out.suppressed, cancelled: out.cancelled };
}

// ---------------------------------------------------------------------------
// Reads: GET /v1/contacts/:id and GET /v1/contacts/:id/timeline
// ---------------------------------------------------------------------------

/** A topic status as GET /v1/contacts/:id and PUT .../topics return it. */
export function topicJson(t: { topicId: string; slug: string; name: string; kind: string; status: string | null; defaultSubscribed: boolean; source: string | null; updatedAt: Date | null }) {
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

/**
 * One contact (by id): profile with public state names, flow memberships,
 * the suppression of its email and its topic statuses. Null when absent.
 */
export async function getContactDetail(ctx: Pick<ServiceContext, "db" | "tenant">, contactId: string) {
  const store = storeFor(ctx.db).apiContacts;
  const tenantId = ctx.tenant.id;
  const contact = await store.getContact({ tenantId, contactId });
  if (contact === null) return null;
  const memberships = await store.listContactMemberships({ tenantId, contactId });
  let suppression: Record<string, unknown> | null = null;
  if (typeof contact.email === "string" && contact.email.length > 0) {
    suppression = await store.findSuppression({ tenantId, email: contact.email });
  }
  const topics = (await store.listContactTopics({ tenantId, contactId })).map(topicJson);
  return { contact: withPublicStates(contact, ["lifecycle_state"]), memberships, suppression, topics };
}

interface TimelineCursor {
  created_at: string;
  id: string;
}

export function encodeTimelineCursor(occurredAt: Date | string | null | undefined, id: string): string {
  const ts = occurredAt instanceof Date ? occurredAt.toISOString() : (occurredAt ?? new Date(0).toISOString());
  const payload: TimelineCursor = { created_at: ts, id };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeTimelineCursor(cursor: string): TimelineCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as Record<string, unknown>).created_at !== "string" ||
      typeof (parsed as Record<string, unknown>).id !== "string"
    ) return null;
    return parsed as TimelineCursor;
  } catch {
    return null;
  }
}

/**
 * One page of a contact's timeline (events, lifecycle transitions and
 * messages), newest first. The contact must exist in the product.
 */
export async function contactTimelinePage(
  ctx: Pick<ServiceContext, "db" | "tenant">,
  contactId: string,
  limit: number,
  after: string | null | undefined,
): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
  const cursor = after ? decodeTimelineCursor(after) : null;
  const rows = await storeFor(ctx.db).apiContacts.listContactTimeline({
    tenantId: ctx.tenant.id,
    contactId,
    before: cursor ? { occurredAt: cursor.created_at, id: cursor.id } : null,
    limit: limit + 1,
  });
  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
  const lastRow = pageRows[pageRows.length - 1] as { occurred_at: string; id: string } | undefined;
  return {
    items: pageRows.map((r) => withPublicStates(r, ["from_state", "to_state"])),
    next_cursor: hasNextPage && lastRow ? encodeTimelineCursor(lastRow.occurred_at, lastRow.id) : null,
  };
}
