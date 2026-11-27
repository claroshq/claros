/**
 * Contact actions and lookups shared by the HTTP routes (routes/contacts.ts)
 * and the MCP tools (mcp/tools.ts).
 */
import { storeFor } from "@claros/store";
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
