/**
 * Postgres implementation of the queries used by packages/api/src/routes/contacts.ts.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { ApiContactsQueries, ContactListRow } from "../areas/api-contacts.js";

export function pgApiContacts(db: PgDb): ApiContactsQueries {
  return {
    async getTenantSettings({ tenantId }) {
      const tenantRows = await db.execute<{ settings: unknown }>(sql`
        SELECT settings FROM tenants WHERE id = ${tenantId}
      `);
      return tenantRows.rows[0]?.settings ?? null;
    },

    async listContacts({ tenantId, filter, limit }) {
      const state = filter.lifecycleState;
      const depth = filter.engagementDepth;
      const search = filter.searchPattern;
      const tenureMin = filter.tenureMinDays;
      const tenureMax = filter.tenureMaxDays;
      const recencyMin = filter.recencyMinDays;
      const recencyMax = filter.recencyMaxDays;
      // DESC keyset: newest contacts first. Rows strictly older than the cursor.
      const cursorClause = filter.before
        ? sql`AND ROW(created_at, id) < ROW(${filter.before.createdAt}::timestamptz, ${filter.before.id}::uuid)`
        : sql``;

      return (
        await db.execute<ContactListRow>(sql`
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
          LIMIT ${limit}
        `)
      ).rows;
    },

    async getContact({ tenantId, contactId }) {
      const contactRows = (
        await db.execute<Record<string, unknown>>(sql`
          SELECT id, tenant_id, external_id, email, name, company, properties,
                 lifecycle_state, engagement_depth, payment_status,
                 first_seen_at, last_seen_at, activated_at, created_at
          FROM contacts
          WHERE tenant_id = ${tenantId} AND id = ${contactId}::uuid
          LIMIT 1
        `)
      ).rows;
      return contactRows[0] ?? null;
    },

    async listContactMemberships({ tenantId, contactId }) {
      return (
        await db.execute<Record<string, unknown>>(sql`
          SELECT m.id, m.flow_id, f.name AS flow_name, m.status, m.current_step,
                 m.entered_at, m.completed_at, m.exited_at, m.exit_reason
          FROM flow_memberships m
          JOIN flows f ON f.id = m.flow_id AND f.tenant_id = ${tenantId}
          WHERE m.tenant_id = ${tenantId} AND m.contact_id = ${contactId}::uuid
          ORDER BY m.entered_at DESC
        `)
      ).rows;
    },

    async findSuppression({ tenantId, email }) {
      const supRows = (
        await db.execute<Record<string, unknown>>(sql`
          SELECT id, reason, source, created_at
          FROM suppressions
          WHERE tenant_id = ${tenantId} AND lower(email) = lower(${email})
          LIMIT 1
        `)
      ).rows;
      return supRows[0] ?? null;
    },

    async contactExists({ tenantId, contactId }) {
      const exists = (
        await db.execute<{ id: string }>(sql`
          SELECT id FROM contacts
          WHERE tenant_id = ${tenantId} AND id = ${contactId}::uuid
          LIMIT 1
        `)
      ).rows;
      return exists.length > 0;
    },

    async listContactTimeline({ tenantId, contactId, before: cursor, limit: fetchLimit }) {
      // DESC keyset: rows strictly older than the cursor, applied inside each
      // branch so the branch LIMIT cannot cut off rows a later page needs.
      const eventCursor = cursor
        ? sql`AND ROW(e."timestamp", e.id) < ROW(${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`
        : sql``;
      const transitionCursor = cursor
        ? sql`AND ROW(t.transitioned_at, t.id) < ROW(${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`
        : sql``;
      const messageCursor = cursor
        ? sql`AND ROW(COALESCE(m.sent_at, m.created_at), m.id) < ROW(${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`
        : sql``;

      return (
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
    },
  };
}
