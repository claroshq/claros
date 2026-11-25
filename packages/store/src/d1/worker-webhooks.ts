/**
 * SQLite / D1 implementation of ../areas/worker-webhooks.ts.
 * The claim is one guarded UPDATE ... WHERE id IN (SELECT ... LIMIT) AND
 * status = 'pending' AND next_attempt_at <= now RETURNING (each row to one caller).
 */
import { sql } from "drizzle-orm";
import type { D1Db } from "./db.js";
import type { WorkerWebhooksQueries, WebhookSubject } from "../areas/worker-webhooks.js";

const json = (v: unknown): Record<string, unknown> | null => {
  if (v == null) return null;
  if (typeof v === "object") return v as Record<string, unknown>;
  try {
    return JSON.parse(String(v)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export function d1WorkerWebhooks(db: D1Db): WorkerWebhooksQueries {
  return {
    async claimDueDeliveries({ now, limit, leaseMs }) {
      const ms = now.getTime();
      const rows = await db.all<{ id: string; tenant_id: string; endpoint_id: string; event: string; payload: string; attempts: number; created_at: number }>(sql`
        UPDATE webhook_outbox
        SET attempts = attempts + 1, next_attempt_at = ${ms + leaseMs}
        WHERE id IN (
          SELECT id FROM webhook_outbox
          WHERE status = 'pending' AND next_attempt_at <= ${ms}
          ORDER BY next_attempt_at, id
          LIMIT ${limit}
        )
          AND status = 'pending' AND next_attempt_at <= ${ms}
        RETURNING id, tenant_id, endpoint_id, event, payload, attempts, created_at
      `);
      if (rows.length === 0) return [];
      const endpointIds = [...new Set(rows.map((r) => r.endpoint_id))];
      const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];
      const eps = await db.all<{ id: string; tenant_id: string; kind: string; url: string; secret: string | null; config: string | null; enabled: number }>(sql`
        SELECT id, tenant_id, kind, url, secret, config, enabled FROM webhook_endpoints
        WHERE id IN (${sql.join(endpointIds.map((id) => sql`${id}`), sql`, `)})
      `);
      const ts = await db.all<{ id: string; slug: string }>(sql`
        SELECT id, slug FROM tenants WHERE id IN (${sql.join(tenantIds.map((id) => sql`${id}`), sql`, `)})
      `);
      const epById = new Map(eps.map((e) => [e.id, e]));
      const slugById = new Map(ts.map((t) => [t.id, t.slug]));
      return rows
        .sort((a, b) => a.created_at - b.created_at)
        .map((r) => {
          const ep = epById.get(r.endpoint_id);
          return {
            id: r.id,
            tenantId: r.tenant_id,
            tenantSlug: slugById.get(r.tenant_id) ?? "",
            event: r.event,
            payload: json(r.payload) ?? {},
            attempts: Number(r.attempts),
            createdAt: new Date(Number(r.created_at)),
            endpoint:
              ep && Number(ep.enabled) === 1 && ep.tenant_id === r.tenant_id
                ? { id: ep.id, kind: ep.kind, url: ep.url, secret: ep.secret, config: json(ep.config) }
                : null,
          };
        });
    },

    async markDelivered({ id, now }) {
      await db.run(sql`
        UPDATE webhook_outbox SET status = 'delivered', delivered_at = ${now.getTime()}, last_error = NULL
        WHERE id = ${id} AND status = 'pending'
      `);
    },

    async markAttemptFailed({ id, error, nextAttemptAt }) {
      await db.run(sql`
        UPDATE webhook_outbox
        SET last_error = ${error.slice(0, 500)},
            status = ${nextAttemptAt ? "pending" : "dead"},
            next_attempt_at = COALESCE(${nextAttemptAt ? nextAttemptAt.getTime() : null}, next_attempt_at)
        WHERE id = ${id} AND status = 'pending'
      `);
    },

    async describeSubject({ tenantId, messageId, membershipId, contactId, flowId, email }) {
      const out: WebhookSubject = { contact: null, message: null, flow: null, topic: null };
      let cId = contactId ?? null;
      let fId = flowId ?? null;
      if (messageId) {
        const [row] = await db.all<{ id: string; subject: string | null; brain_action_type: string | null; flow_step_order: number | null; status: string; contact_id: string; flow_id: string; topic_id: string | null }>(sql`
          SELECT id, subject, brain_action_type, flow_step_order, status, contact_id, flow_id, topic_id
          FROM lifecycle_messages WHERE id = ${messageId} AND tenant_id = ${tenantId}
        `);
        if (row) {
          out.message = { id: row.id, subject: row.subject, actionType: row.brain_action_type, step: row.flow_step_order, status: row.status };
          cId ??= row.contact_id;
          fId ??= row.flow_id;
          if (row.topic_id) {
            const [t] = await db.all<{ slug: string; kind: string }>(sql`SELECT slug, kind FROM topics WHERE id = ${row.topic_id} AND tenant_id = ${tenantId}`);
            out.topic = t ?? null;
          }
        }
      }
      if (membershipId && (!cId || !fId)) {
        const [m] = await db.all<{ contact_id: string; flow_id: string }>(sql`
          SELECT contact_id, flow_id FROM flow_memberships WHERE id = ${membershipId} AND tenant_id = ${tenantId}
        `);
        cId ??= m?.contact_id ?? null;
        fId ??= m?.flow_id ?? null;
      }
      if (cId) {
        const [row] = await db.all<{ id: string; external_id: string; email: string | null }>(sql`
          SELECT id, external_id, email FROM contacts WHERE id = ${cId} AND tenant_id = ${tenantId}
        `);
        if (row) out.contact = { id: row.id, externalId: row.external_id, email: row.email };
      } else if (email) {
        const [row] = await db.all<{ id: string; external_id: string; email: string | null }>(sql`
          SELECT id, external_id, email FROM contacts WHERE tenant_id = ${tenantId} AND lower(email) = lower(${email})
          ORDER BY created_at IS NULL, created_at LIMIT 1
        `);
        if (row) out.contact = { id: row.id, externalId: row.external_id, email: row.email };
      }
      if (fId) {
        const [f] = await db.all<{ id: string; slug: string | null; name: string }>(sql`
          SELECT id, slug, name FROM flows WHERE id = ${fId} AND tenant_id = ${tenantId}
        `);
        out.flow = f ?? null;
      }
      return out;
    },

    async countPendingApprovals(tenantId) {
      const [row] = await db.all<{ n: number }>(sql`
        SELECT count(*) AS n FROM lifecycle_messages WHERE tenant_id = ${tenantId} AND status = 'pending_approval'
      `);
      return Number(row?.n ?? 0);
    },
  };
}
