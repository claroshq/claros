/**
 * Postgres lookups for contact conditions (../areas/shared-conditions.ts).
 * Uses idx_messages_contact_sent (contact_id, sent_at) for the history count.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import { withReservedTraits, type ContactConditionQueries, type ReservedTraitColumns } from "../areas/shared-conditions.js";

export function pgContactConditions(db: PgDb): ContactConditionQueries {
  return {
    async getContactTraits({ tenantId, contactId }) {
      const res = await db.execute<ReservedTraitColumns & { properties: Record<string, unknown> | null }>(sql`
        SELECT properties, email, name, company, payment_status FROM contacts WHERE id = ${contactId}::uuid AND tenant_id = ${tenantId}::uuid
      `);
      const row = res.rows[0];
      if (!row) return null;
      return withReservedTraits(row.properties && typeof row.properties === "object" ? row.properties : {}, row);
    },

    async countSends({ tenantId, contactId, flow, actionType, topic, since }) {
      const res = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
        FROM lifecycle_messages m
        WHERE m.contact_id = ${contactId}::uuid
          AND m.tenant_id = ${tenantId}::uuid
          AND m.status IN ('sending', 'sent')
          ${since ? sql`AND m.sent_at >= ${since}` : sql``}
          ${actionType ? sql`AND m.brain_action_type = ${actionType}` : sql``}
          ${flow ? sql`AND m.flow_id IN (SELECT id FROM flows WHERE tenant_id = ${tenantId}::uuid AND (slug = ${flow} OR id::text = ${flow}))` : sql``}
          ${topic ? sql`AND m.topic_id IN (SELECT id FROM topics WHERE tenant_id = ${tenantId}::uuid AND slug = ${topic})` : sql``}
      `);
      return Number(res.rows[0]?.n ?? 0);
    },

    async lookupLifecycleState({ tenantId, contactId }) {
      const res = await db.execute<{ lifecycle_state: string }>(sql`
        SELECT lifecycle_state FROM contacts WHERE id = ${contactId}::uuid AND tenant_id = ${tenantId}::uuid
      `);
      return res.rows[0]?.lifecycle_state ?? null;
    },
  };
}
