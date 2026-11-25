/**
 * Postgres implementation of ../areas/worker-webhooks.ts.
 * The claim is one UPDATE over a FOR UPDATE SKIP LOCKED subselect.
 */
import { sql } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { WorkerWebhooksQueries, WebhookSubject } from "../areas/worker-webhooks.js";

export function pgWorkerWebhooks(db: PgDb): WorkerWebhooksQueries {
  return {
    async claimDueDeliveries({ now, limit, leaseMs }) {
      const lease = new Date(now.getTime() + leaseMs);
      const res = await db.execute<{
        id: string;
        tenant_id: string;
        endpoint_id: string;
        event: string;
        payload: Record<string, unknown>;
        attempts: number;
        created_at: Date | string;
      }>(sql`
        UPDATE webhook_outbox o
        SET attempts = o.attempts + 1, next_attempt_at = ${lease}
        WHERE o.id IN (
          SELECT id FROM webhook_outbox
          WHERE status = 'pending' AND next_attempt_at <= ${now}
          ORDER BY next_attempt_at, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING o.id, o.tenant_id, o.endpoint_id, o.event, o.payload, o.attempts, o.created_at
      `);
      if (res.rows.length === 0) return [];
      const endpointIds = [...new Set(res.rows.map((r) => r.endpoint_id))];
      const tenantIds = [...new Set(res.rows.map((r) => r.tenant_id))];
      const eps = await db.execute<{ id: string; tenant_id: string; kind: string; url: string; secret: string | null; config: Record<string, unknown> | null; enabled: boolean }>(sql`
        SELECT id, tenant_id, kind, url, secret, config, enabled FROM webhook_endpoints
        WHERE id IN (${sql.join(endpointIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `);
      const ts = await db.execute<{ id: string; slug: string }>(sql`
        SELECT id, slug FROM tenants WHERE id IN (${sql.join(tenantIds.map((id) => sql`${id}::uuid`), sql`, `)})
      `);
      const epById = new Map(eps.rows.map((e) => [e.id, e]));
      const slugById = new Map(ts.rows.map((t) => [t.id, t.slug]));
      return res.rows
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .map((r) => {
          const ep = epById.get(r.endpoint_id);
          return {
            id: r.id,
            tenantId: r.tenant_id,
            tenantSlug: slugById.get(r.tenant_id) ?? "",
            event: r.event,
            payload: r.payload ?? {},
            attempts: r.attempts,
            createdAt: new Date(r.created_at),
            endpoint:
              ep && ep.enabled && ep.tenant_id === r.tenant_id
                ? { id: ep.id, kind: ep.kind, url: ep.url, secret: ep.secret, config: ep.config }
                : null,
          };
        });
    },

    async markDelivered({ id, now }) {
      await db.execute(sql`
        UPDATE webhook_outbox SET status = 'delivered', delivered_at = ${now}, last_error = NULL
        WHERE id = ${id}::uuid AND status = 'pending'
      `);
    },

    async markAttemptFailed({ id, error, nextAttemptAt }) {
      await db.execute(sql`
        UPDATE webhook_outbox
        SET last_error = ${error.slice(0, 500)},
            status = ${nextAttemptAt ? "pending" : "dead"},
            next_attempt_at = COALESCE(${nextAttemptAt}::timestamptz, next_attempt_at)
        WHERE id = ${id}::uuid AND status = 'pending'
      `);
    },

    async describeSubject({ tenantId, messageId, membershipId, contactId, flowId, email }) {
      const out: WebhookSubject = { contact: null, message: null, flow: null, topic: null };
      let cId = contactId ?? null;
      let fId = flowId ?? null;
      if (messageId) {
        const m = await db.execute<{ id: string; subject: string | null; brain_action_type: string | null; flow_step_order: number | null; status: string; contact_id: string; flow_id: string; topic_id: string | null }>(sql`
          SELECT id, subject, brain_action_type, flow_step_order, status, contact_id, flow_id, topic_id
          FROM lifecycle_messages WHERE id = ${messageId}::uuid AND tenant_id = ${tenantId}::uuid
        `);
        const row = m.rows[0];
        if (row) {
          out.message = { id: row.id, subject: row.subject, actionType: row.brain_action_type, step: row.flow_step_order, status: row.status };
          cId ??= row.contact_id;
          fId ??= row.flow_id;
          if (row.topic_id) {
            const t = await db.execute<{ slug: string; kind: string }>(sql`SELECT slug, kind FROM topics WHERE id = ${row.topic_id}::uuid AND tenant_id = ${tenantId}::uuid`);
            out.topic = t.rows[0] ?? null;
          }
        }
      }
      if (membershipId && (!cId || !fId)) {
        const m = await db.execute<{ contact_id: string; flow_id: string }>(sql`
          SELECT contact_id, flow_id FROM flow_memberships WHERE id = ${membershipId}::uuid AND tenant_id = ${tenantId}::uuid
        `);
        cId ??= m.rows[0]?.contact_id ?? null;
        fId ??= m.rows[0]?.flow_id ?? null;
      }
      if (cId) {
        const c = await db.execute<{ id: string; external_id: string; email: string | null }>(sql`
          SELECT id, external_id, email FROM contacts WHERE id = ${cId}::uuid AND tenant_id = ${tenantId}::uuid
        `);
        const row = c.rows[0];
        if (row) out.contact = { id: row.id, externalId: row.external_id, email: row.email };
      } else if (email) {
        const c = await db.execute<{ id: string; external_id: string; email: string | null }>(sql`
          SELECT id, external_id, email FROM contacts WHERE tenant_id = ${tenantId}::uuid AND lower(email) = lower(${email})
          ORDER BY created_at LIMIT 1
        `);
        const row = c.rows[0];
        if (row) out.contact = { id: row.id, externalId: row.external_id, email: row.email };
      }
      if (fId) {
        const f = await db.execute<{ id: string; slug: string | null; name: string }>(sql`
          SELECT id, slug, name FROM flows WHERE id = ${fId}::uuid AND tenant_id = ${tenantId}::uuid
        `);
        out.flow = f.rows[0] ?? null;
      }
      return out;
    },

    async countPendingApprovals(tenantId) {
      const res = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM lifecycle_messages WHERE tenant_id = ${tenantId}::uuid AND status = 'pending_approval'
      `);
      return Number(res.rows[0]?.n ?? 0);
    },
  };
}
