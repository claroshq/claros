/**
 * Postgres: write outbox rows for state changes (see ../areas/shared-outbox.ts).
 * Call with the transaction handle of the state change.
 */
import { and, eq } from "drizzle-orm";
import { webhookEndpoints, webhookOutbox } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { OutboxEntry } from "../areas/shared-outbox.js";

export async function pgWriteOutbox(tx: PgDb, tenantId: string, entries: readonly OutboxEntry[] | undefined, now: Date): Promise<number> {
  if (!entries || entries.length === 0) return 0;
  const endpoints = await tx
    .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.tenantId, tenantId), eq(webhookEndpoints.enabled, true)));
  const rows = outboxRows(tenantId, endpoints, entries, now);
  if (rows.length === 0) return 0;
  const inserted = await tx.insert(webhookOutbox).values(rows).onConflictDoNothing().returning({ id: webhookOutbox.id });
  return inserted.length;
}

export function outboxRows(
  tenantId: string,
  endpoints: ReadonlyArray<{ id: string; events: unknown }>,
  entries: readonly OutboxEntry[],
  now: Date,
) {
  const rows: Array<typeof webhookOutbox.$inferInsert> = [];
  for (const entry of entries) {
    for (const ep of endpoints) {
      const events = Array.isArray(ep.events) ? (ep.events as string[]) : [];
      if (!events.includes(entry.event)) continue;
      rows.push({
        id: crypto.randomUUID(),
        tenantId,
        endpointId: ep.id,
        event: entry.event,
        payload: entry.payload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: entry.deliverAt ?? now,
        dedupKey: entry.dedupKey ?? null,
        createdAt: now,
      });
    }
  }
  return rows;
}
