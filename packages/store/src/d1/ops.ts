/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/ops.ts.
 *
 * recordEvent: the event insert and the alert upsert are one batch (one
 * SQLite transaction), as the Postgres transaction. bumpCounter is one
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement (atomic).
 * Raw SQL binds timestamps as integer milliseconds and reads them back as
 * Date. groupEventsSince picks the latest occurrence per fingerprint with a
 * correlated subquery instead of LATERAL.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { instanceSettings, opsAlerts, opsEvents, tenants, users } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import { rawBatch } from "./raw-batch.js";
import type { OpsAlertRow, OpsQueries } from "../areas/ops.js";

const alertColumns = {
  fingerprint: opsAlerts.fingerprint,
  kind: opsAlerts.kind,
  tenantId: opsAlerts.tenantId,
  severity: opsAlerts.severity,
  message: opsAlerts.message,
  firstAt: opsAlerts.firstAt,
  lastAt: opsAlerts.lastAt,
  count: opsAlerts.count,
  lastNotifiedAt: opsAlerts.lastNotifiedAt,
  notifiedCount: opsAlerts.notifiedCount,
  status: opsAlerts.status,
  mutedUntil: opsAlerts.mutedUntil,
};

/** LIKE pattern for "starts with" (escapes % and _ with ESCAPE '\'). */
function prefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const n = (v: unknown): number => Number(v ?? 0);

export function d1Ops(db: D1Db): OpsQueries {
  return {
    async recordEvent(event, { alert }) {
      const at = event.at.getTime();
      const context = event.context === undefined || event.context === null ? null : JSON.stringify(event.context);
      const statements = [
        sql`INSERT INTO ops_events (id, at, tenant_id, kind, severity, fingerprint, message, context)
            VALUES (${crypto.randomUUID()}, ${at}, ${event.tenantId}, ${event.kind}, ${event.severity},
                    ${event.fingerprint}, ${event.message}, ${context})`,
      ];
      if (alert) {
        statements.push(sql`
          INSERT INTO ops_alerts (fingerprint, kind, tenant_id, severity, message, first_at, last_at, count, notified_count, status)
          VALUES (${event.fingerprint}, ${event.kind}, ${event.tenantId}, ${event.severity}, ${event.message},
                  ${at}, ${at}, 1, 0, 'open')
          ON CONFLICT (fingerprint) DO UPDATE SET
            kind = excluded.kind,
            tenant_id = excluded.tenant_id,
            severity = excluded.severity,
            message = excluded.message,
            last_at = max(ops_alerts.last_at, excluded.last_at),
            count = CASE WHEN ops_alerts.status = 'resolved' THEN 1 ELSE ops_alerts.count + 1 END,
            first_at = CASE WHEN ops_alerts.status = 'resolved' THEN excluded.first_at ELSE ops_alerts.first_at END,
            last_notified_at = CASE WHEN ops_alerts.status = 'resolved' THEN NULL ELSE ops_alerts.last_notified_at END,
            notified_count = CASE WHEN ops_alerts.status = 'resolved' THEN 0 ELSE ops_alerts.notified_count END,
            status = 'open'
        `);
      }
      await rawBatch(db, statements);
    },

    async touchAlert({ fingerprint, at }) {
      const rows = await db
        .update(opsAlerts)
        .set({ count: sql`${opsAlerts.count} + 1`, lastAt: sql`max(${opsAlerts.lastAt}, ${at.getTime()})` })
        .where(and(eq(opsAlerts.fingerprint, fingerprint), eq(opsAlerts.status, "open")))
        .returning({ fingerprint: opsAlerts.fingerprint });
      return rows.length > 0;
    },

    async listAlerts({ status, limit }) {
      const q = db.select(alertColumns).from(opsAlerts);
      const rows = await (status ? q.where(eq(opsAlerts.status, status)) : q)
        .orderBy(desc(opsAlerts.lastAt), asc(opsAlerts.fingerprint))
        .limit(limit);
      return rows as OpsAlertRow[];
    },

    async getAlert(fingerprint) {
      const rows = await db.select(alertColumns).from(opsAlerts).where(eq(opsAlerts.fingerprint, fingerprint)).limit(1);
      return (rows[0] as OpsAlertRow | undefined) ?? null;
    },

    async claimNotification({ fingerprint, expectedLastNotifiedAt, at }) {
      const rows = await db
        .update(opsAlerts)
        .set({ lastNotifiedAt: at, notifiedCount: sql`${opsAlerts.count}` })
        .where(
          and(
            eq(opsAlerts.fingerprint, fingerprint),
            eq(opsAlerts.status, "open"),
            expectedLastNotifiedAt === null
              ? isNull(opsAlerts.lastNotifiedAt)
              : eq(opsAlerts.lastNotifiedAt, expectedLastNotifiedAt),
          ),
        )
        .returning({ fingerprint: opsAlerts.fingerprint });
      return rows.length > 0;
    },

    async resolveAlert({ fingerprint }) {
      const rows = await db
        .update(opsAlerts)
        .set({ status: "resolved" })
        .where(and(eq(opsAlerts.fingerprint, fingerprint), eq(opsAlerts.status, "open")))
        .returning(alertColumns);
      return (rows[0] as OpsAlertRow | undefined) ?? null;
    },

    async resolveStaleAlerts({ before }) {
      const rows = await db
        .update(opsAlerts)
        .set({ status: "resolved" })
        .where(and(eq(opsAlerts.status, "open"), lt(opsAlerts.lastAt, before)))
        .returning(alertColumns);
      return rows as OpsAlertRow[];
    },

    async muteAlert({ fingerprint, until }) {
      const rows = await db
        .update(opsAlerts)
        .set({ mutedUntil: until })
        .where(eq(opsAlerts.fingerprint, fingerprint))
        .returning(alertColumns);
      return (rows[0] as OpsAlertRow | undefined) ?? null;
    },

    async listEvents({ since, limit }) {
      return db
        .select({
          id: opsEvents.id,
          at: opsEvents.at,
          tenantId: opsEvents.tenantId,
          kind: opsEvents.kind,
          severity: opsEvents.severity,
          fingerprint: opsEvents.fingerprint,
          message: opsEvents.message,
          context: opsEvents.context,
        })
        .from(opsEvents)
        .where(gte(opsEvents.at, since))
        .orderBy(desc(opsEvents.at), desc(opsEvents.id))
        .limit(limit);
    },

    async groupEventsSince({ since }) {
      const s = since.getTime();
      const rows = await db.all<{
        fingerprint: string;
        kind: string;
        tenant_id: string | null;
        severity: string;
        message: string;
        count: number;
        last_at: number;
      }>(sql`
        SELECT g.fingerprint, l.kind, l.tenant_id, l.severity, l.message, g.count, g.last_at
        FROM (
          SELECT fingerprint, count(*) AS count, max(at) AS last_at,
            (SELECT e.id FROM ops_events e
             WHERE e.fingerprint = o.fingerprint AND e.at >= ${s}
             ORDER BY e.at DESC, e.id DESC LIMIT 1) AS latest_id
          FROM ops_events o WHERE at >= ${s}
          GROUP BY fingerprint
        ) g
        JOIN ops_events l ON l.id = g.latest_id
        ORDER BY g.count DESC, g.last_at DESC, g.fingerprint ASC
      `);
      return rows.map((r) => ({
        fingerprint: r.fingerprint,
        kind: r.kind,
        tenantId: r.tenant_id,
        severity: r.severity,
        message: r.message,
        count: n(r.count),
        lastAt: new Date(n(r.last_at)),
      }));
    },

    async countEventsSince({ kinds, since }) {
      if (kinds.length === 0) return 0;
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(opsEvents)
        .where(and(inArray(opsEvents.kind, kinds), gte(opsEvents.at, since)));
      return n(row?.n);
    },

    async deleteEventsBefore(before) {
      const rows = await db.delete(opsEvents).where(lt(opsEvents.at, before)).returning({ id: opsEvents.id });
      return rows.length;
    },

    async deleteResolvedAlertsBefore(before) {
      const rows = await db
        .delete(opsAlerts)
        .where(and(eq(opsAlerts.status, "resolved"), lt(opsAlerts.lastAt, before)))
        .returning({ fingerprint: opsAlerts.fingerprint });
      return rows.length;
    },

    async getSetting(key) {
      const rows = await db
        .select({ key: instanceSettings.key, value: instanceSettings.value, updatedAt: instanceSettings.updatedAt })
        .from(instanceSettings)
        .where(eq(instanceSettings.key, key))
        .limit(1);
      return rows[0] ?? null;
    },

    async putSetting({ key, value, now }) {
      await db
        .insert(instanceSettings)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: now } });
    },

    async listSettingsByPrefix(prefix) {
      return db
        .select({ key: instanceSettings.key, value: instanceSettings.value, updatedAt: instanceSettings.updatedAt })
        .from(instanceSettings)
        .where(sql`${instanceSettings.key} LIKE ${prefixPattern(prefix)} ESCAPE '\\'`)
        .orderBy(asc(instanceSettings.key));
    },

    async deleteSettingsByPrefixBefore({ prefix, before }) {
      const rows = await db
        .delete(instanceSettings)
        .where(
          and(
            sql`${instanceSettings.key} LIKE ${prefixPattern(prefix)} ESCAPE '\\'`,
            lt(instanceSettings.updatedAt, before),
          ),
        )
        .returning({ key: instanceSettings.key });
      return rows.length;
    },

    async bumpCounter({ key, windowStart, count, errors, now }) {
      const fresh = JSON.stringify({ window_start: windowStart, count, errors });
      const rows = await db.all<{ value: string }>(sql`
        INSERT INTO instance_settings (key, value, updated_at)
        VALUES (${key}, ${fresh}, ${now.getTime()})
        ON CONFLICT (key) DO UPDATE SET
          value = CASE
            WHEN json_extract(instance_settings.value, '$.window_start') = ${windowStart} THEN json_object(
              'window_start', ${windowStart},
              'count', COALESCE(json_extract(instance_settings.value, '$.count'), 0) + ${count},
              'errors', COALESCE(json_extract(instance_settings.value, '$.errors'), 0) + ${errors})
            ELSE excluded.value
          END,
          updated_at = excluded.updated_at
        RETURNING value
      `);
      const raw = rows[0]?.value;
      const v = (typeof raw === "string" ? JSON.parse(raw) : raw ?? { count, errors }) as { count: number; errors: number };
      return { count: n(v.count), errors: n(v.errors) };
    },

    async sendOutcomesSince({ since, stuckBefore }) {
      const s = since.getTime();
      const sb = stuckBefore.getTime();
      const rows = await db.all<{
        tenant_id: string;
        transport_id: string | null;
        kind: string | null;
        name: string | null;
        sent: number;
        failed: number;
        stuck: number;
      }>(sql`
        SELECT m.tenant_id, m.transport_id, COALESCE(t.kind, t.provider) AS kind, t.name,
          SUM(CASE WHEN m.status = 'sent' AND m.sent_at >= ${s} THEN 1 ELSE 0 END) AS sent,
          SUM(CASE WHEN m.status = 'failed' AND m.updated_at >= ${s} THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN m.status = 'sending' AND m.updated_at >= ${s} AND m.updated_at < ${sb} THEN 1 ELSE 0 END) AS stuck
        FROM lifecycle_messages m
        LEFT JOIN transport_configs t ON t.id = m.transport_id AND t.tenant_id = m.tenant_id
        WHERE m.recipient_address IS NOT NULL
          AND (
            (m.status = 'sent' AND m.sent_at >= ${s})
            OR (m.status IN ('failed', 'sending') AND m.updated_at >= ${s})
          )
        GROUP BY m.tenant_id, m.transport_id, COALESCE(t.kind, t.provider), t.name
        ORDER BY m.tenant_id, m.transport_id IS NULL, m.transport_id
      `);
      return rows.map((r) => ({
        tenantId: r.tenant_id,
        transportId: r.transport_id,
        transportKind: r.kind,
        transportName: r.name,
        sent: n(r.sent),
        failed: n(r.failed),
        stuck: n(r.stuck),
      }));
    },

    async sendFailureReasonsSince({ since, limit }) {
      const rows = await db.all<{
        tenant_id: string;
        transport_id: string | null;
        kind: string | null;
        status_reason: string;
      }>(sql`
        SELECT m.tenant_id, m.transport_id, COALESCE(t.kind, t.provider) AS kind, m.status_reason
        FROM lifecycle_messages m
        LEFT JOIN transport_configs t ON t.id = m.transport_id AND t.tenant_id = m.tenant_id
        WHERE m.status = 'failed' AND m.updated_at >= ${since.getTime()}
          AND m.recipient_address IS NOT NULL AND m.status_reason IS NOT NULL
        ORDER BY m.updated_at DESC, m.id DESC
        LIMIT ${limit}
      `);
      return rows.map((r) => ({
        tenantId: r.tenant_id,
        transportId: r.transport_id,
        transportKind: r.kind,
        reason: r.status_reason,
      }));
    },

    async sendTotalsSince(since) {
      const s = since.getTime();
      const rows = await db.all<{ tenant_id: string; sent: number; failed: number }>(sql`
        SELECT tenant_id,
          SUM(CASE WHEN status = 'sent' AND sent_at >= ${s} THEN 1 ELSE 0 END) AS sent,
          SUM(CASE WHEN status = 'failed' AND updated_at >= ${s} THEN 1 ELSE 0 END) AS failed
        FROM lifecycle_messages
        WHERE (status = 'sent' AND sent_at >= ${s}) OR (status = 'failed' AND updated_at >= ${s})
        GROUP BY tenant_id
        ORDER BY tenant_id
      `);
      return rows.map((r) => ({ tenantId: r.tenant_id, sent: n(r.sent), failed: n(r.failed) }));
    },

    async pendingApprovals() {
      const rows = await db.all<{ tenant_id: string; pending: number; oldest_at: number | null }>(sql`
        SELECT tenant_id, count(*) AS pending, min(created_at) AS oldest_at
        FROM lifecycle_messages
        WHERE status = 'pending_approval'
        GROUP BY tenant_id
        ORDER BY tenant_id
      `);
      return rows.map((r) => ({
        tenantId: r.tenant_id,
        pending: n(r.pending),
        oldestAt: r.oldest_at === null ? null : new Date(n(r.oldest_at)),
      }));
    },

    async listProducts() {
      return db
        .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
        .from(tenants)
        .orderBy(sql`${tenants.createdAt} IS NULL`, asc(tenants.createdAt), asc(tenants.id));
    },

    async firstInstanceAdminEmail() {
      const rows = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.instanceRole, "admin"), isNull(users.deactivatedAt)))
        .orderBy(sql`${users.createdAt} IS NULL`, asc(users.createdAt), asc(users.id))
        .limit(1);
      return rows[0]?.email ?? null;
    },
  };
}
