/** Webhook endpoint and outbox fixtures shared by the G5-aware contract tests. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Backend } from "./backends.js";

export async function insertEndpoint(b: Backend, tenantId: string, events: string[], values: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.webhookEndpoints).values({
    id,
    tenantId,
    slug: `ep-${id.slice(0, 8)}`,
    kind: "webhook",
    url: "http://127.0.0.1:9/claros",
    events,
    ...values,
  });
  return id;
}

/** The product's outbox rows as (event, payload) sorted by event then payload JSON. */
export async function outboxOf(b: Backend, tenantId: string): Promise<Array<{ event: string; payload: any; endpointId: string; dedupKey: string | null }>> {
  const rows = await b.db
    .select({
      event: b.schema.webhookOutbox.event,
      payload: b.schema.webhookOutbox.payload,
      endpointId: b.schema.webhookOutbox.endpointId,
      dedupKey: b.schema.webhookOutbox.dedupKey,
    })
    .from(b.schema.webhookOutbox)
    .where(eq(b.schema.webhookOutbox.tenantId, tenantId));
  return rows
    .map((r: any) => ({ ...r, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload }))
    .sort((x: any, y: any) => (x.event + JSON.stringify(x.payload)).localeCompare(y.event + JSON.stringify(y.payload)));
}
