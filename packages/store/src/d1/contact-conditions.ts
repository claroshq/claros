/**
 * SQLite / D1 lookups for contact conditions (../areas/shared-conditions.ts).
 */
import { sql } from "drizzle-orm";
import type { D1Db } from "./db.js";
import { withReservedTraits, type ContactConditionQueries, type ReservedTraitColumns } from "../areas/shared-conditions.js";

export function d1ContactConditions(db: D1Db): ContactConditionQueries {
  return {
    async getContactTraits({ tenantId, contactId }) {
      const rows = await db.all<ReservedTraitColumns & { properties: string | null }>(sql`
        SELECT properties, email, name, company, payment_status FROM contacts WHERE id = ${contactId} AND tenant_id = ${tenantId}
      `);
      const row = rows[0];
      if (!row) return null;
      let props: Record<string, unknown> = {};
      if (row.properties) {
        try {
          const parsed = JSON.parse(row.properties) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) props = parsed as Record<string, unknown>;
        } catch {
          // unreadable properties: the reserved columns still count
        }
      }
      return withReservedTraits(props, row);
    },

    async countSends({ tenantId, contactId, flow, actionType, topic, since }) {
      const rows = await db.all<{ n: number }>(sql`
        SELECT count(*) AS n
        FROM lifecycle_messages m
        WHERE m.contact_id = ${contactId}
          AND m.tenant_id = ${tenantId}
          AND m.status IN ('sending', 'sent')
          ${since ? sql`AND m.sent_at >= ${since.getTime()}` : sql``}
          ${actionType ? sql`AND m.brain_action_type = ${actionType}` : sql``}
          ${flow ? sql`AND m.flow_id IN (SELECT id FROM flows WHERE tenant_id = ${tenantId} AND (slug = ${flow} OR id = ${flow}))` : sql``}
          ${topic ? sql`AND m.topic_id IN (SELECT id FROM topics WHERE tenant_id = ${tenantId} AND slug = ${topic})` : sql``}
      `);
      return Number(rows[0]?.n ?? 0);
    },

    async lookupLifecycleState({ tenantId, contactId }) {
      const rows = await db.all<{ lifecycle_state: string }>(sql`
        SELECT lifecycle_state FROM contacts WHERE id = ${contactId} AND tenant_id = ${tenantId}
      `);
      return rows[0]?.lifecycle_state ?? null;
    },
  };
}
