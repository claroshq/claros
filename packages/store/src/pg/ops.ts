/**
 * Postgres implementation of the queries in ../areas/ops.ts.
 */
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, sql } from "drizzle-orm";
import { instanceSettings, opsAlerts, opsEvents, tenants, users } from "@claros/db/schema";
import type { PgDb } from "./db.js";
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

/** LIKE pattern for "starts with" (escapes % and _). */
function prefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function pgOps(db: PgDb): OpsQueries {
  return {
    async recordEvent(event, { alert }) {
      await db.transaction(async (tx) => {
        await tx.insert(opsEvents).values({
          at: event.at,
          tenantId: event.tenantId,
          kind: event.kind,
          severity: event.severity,
          fingerprint: event.fingerprint,
          message: event.message,
          context: event.context ?? null,
        });
        if (!alert) return;
        await tx.execute(sql`
          INSERT INTO ops_alerts (fingerprint, kind, tenant_id, severity, message, first_at, last_at, count, notified_count, status)
          VALUES (${event.fingerprint}, ${event.kind}, ${event.tenantId}, ${event.severity}, ${event.message},
                  ${event.at}, ${event.at}, 1, 0, 'open')
          ON CONFLICT (fingerprint) DO UPDATE SET
            kind = EXCLUDED.kind,
            tenant_id = EXCLUDED.tenant_id,
            severity = EXCLUDED.severity,
            message = EXCLUDED.message,
            last_at = GREATEST(ops_alerts.last_at, EXCLUDED.last_at),
            count = CASE WHEN ops_alerts.status = 'resolved' THEN 1 ELSE ops_alerts.count + 1 END,
            first_at = CASE WHEN ops_alerts.status = 'resolved' THEN EXCLUDED.first_at ELSE ops_alerts.first_at END,
            last_notified_at = CASE WHEN ops_alerts.status = 'resolved' THEN NULL ELSE ops_alerts.last_notified_at END,
            notified_count = CASE WHEN ops_alerts.status = 'resolved' THEN 0 ELSE ops_alerts.notified_count END,
            status = 'open'
        `);
      });
    },

    async touchAlert({ fingerprint, at }) {
      const rows = await db
        .update(opsAlerts)
        .set({ count: sql`${opsAlerts.count} + 1`, lastAt: sql`GREATEST(${opsAlerts.lastAt}, ${at})` })
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
      // The latest occurrence per fingerprint carries kind, product, severity and message.
      const rows = await db.execute<{
        fingerprint: string;
        kind: string;
        tenant_id: string | null;
        severity: string;
        message: string;
        count: number;
        last_at: Date | string;
      }>(sql`
        SELECT g.fingerprint, l.kind, l.tenant_id, l.severity, l.message, g.count, g.last_at
        FROM (
          SELECT fingerprint, count(*)::int AS count, max(at) AS last_at
          FROM ops_events WHERE at >= ${since}
          GROUP BY fingerprint
        ) g
        JOIN LATERAL (
          SELECT kind, tenant_id, severity, message FROM ops_events e
          WHERE e.fingerprint = g.fingerprint AND e.at >= ${since}
          ORDER BY e.at DESC, e.id DESC LIMIT 1
        ) l ON true
        ORDER BY g.count DESC, g.last_at DESC, g.fingerprint ASC
      `);
      return rows.rows.map((r) => ({
        fingerprint: r.fingerprint,
        kind: r.kind,
        tenantId: r.tenant_id,
        severity: r.severity,
        message: r.message,
        count: Number(r.count),
        lastAt: new Date(r.last_at),
      }));
    },

    async countEventsSince({ kinds, since }) {
      if (kinds.length === 0) return 0;
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(opsEvents)
        .where(and(inArray(opsEvents.kind, kinds), gte(opsEvents.at, since)));
      return Number(row?.n ?? 0);
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
        .where(like(instanceSettings.key, prefixPattern(prefix)))
        .orderBy(asc(instanceSettings.key));
    },

    async deleteSettingsByPrefixBefore({ prefix, before }) {
      const rows = await db
        .delete(instanceSettings)
        .where(and(like(instanceSettings.key, prefixPattern(prefix)), lt(instanceSettings.updatedAt, before)))
        .returning({ key: instanceSettings.key });
      return rows.length;
    },

    async bumpCounter({ key, windowStart, count, errors, now }) {
      const fresh = { window_start: windowStart, count, errors };
      const rows = await db.execute<{ value: { count: number; errors: number } }>(sql`
        INSERT INTO instance_settings (key, value, updated_at)
        VALUES (${key}, ${JSON.stringify(fresh)}::jsonb, ${now})
        ON CONFLICT (key) DO UPDATE SET
          value = CASE
            WHEN (instance_settings.value->>'window_start')::bigint = ${windowStart} THEN jsonb_build_object(
              'window_start', ${windowStart}::bigint,
              'count', COALESCE((instance_settings.value->>'count')::int, 0) + ${count}::int,
              'errors', COALESCE((instance_settings.value->>'errors')::int, 0) + ${errors}::int)
            ELSE EXCLUDED.value
          END,
          updated_at = EXCLUDED.updated_at
        RETURNING value
      `);
      const v = rows.rows[0]?.value ?? fresh;
      return { count: Number(v.count), errors: Number(v.errors) };
    },

    async sendOutcomesSince({ since, stuckBefore }) {
      const rows = await db.execute<{
        tenant_id: string;
        transport_id: string | null;
        kind: string | null;
        name: string | null;
        sent: number;
        failed: number;
        stuck: number;
      }>(sql`
        SELECT m.tenant_id, m.transport_id, COALESCE(t.kind, t.provider) AS kind, t.name,
          count(*) FILTER (WHERE m.status = 'sent' AND m.sent_at >= ${since})::int AS sent,
          count(*) FILTER (WHERE m.status = 'failed' AND m.updated_at >= ${since})::int AS failed,
          count(*) FILTER (WHERE m.status = 'sending' AND m.updated_at >= ${since} AND m.updated_at < ${stuckBefore})::int AS stuck
        FROM lifecycle_messages m
        LEFT JOIN transport_configs t ON t.id = m.transport_id AND t.tenant_id = m.tenant_id
        WHERE m.recipient_address IS NOT NULL
          AND (
            (m.status = 'sent' AND m.sent_at >= ${since})
            OR (m.status IN ('failed', 'sending') AND m.updated_at >= ${since})
          )
        GROUP BY m.tenant_id, m.transport_id, COALESCE(t.kind, t.provider), t.name
        ORDER BY m.tenant_id, m.transport_id NULLS LAST
      `);
      return rows.rows.map((r) => ({
        tenantId: r.tenant_id,
        transportId: r.transport_id,
        transportKind: r.kind,
        transportName: r.name,
        sent: Number(r.sent),
        failed: Number(r.failed),
        stuck: Number(r.stuck),
      }));
    },

    async sendFailureReasonsSince({ since, limit }) {
      const rows = await db.execute<{
        tenant_id: string;
        transport_id: string | null;
        kind: string | null;
        status_reason: string;
      }>(sql`
        SELECT m.tenant_id, m.transport_id, COALESCE(t.kind, t.provider) AS kind, m.status_reason
        FROM lifecycle_messages m
        LEFT JOIN transport_configs t ON t.id = m.transport_id AND t.tenant_id = m.tenant_id
        WHERE m.status = 'failed' AND m.updated_at >= ${since}
          AND m.recipient_address IS NOT NULL AND m.status_reason IS NOT NULL
        ORDER BY m.updated_at DESC, m.id DESC
        LIMIT ${limit}
      `);
      return rows.rows.map((r) => ({
        tenantId: r.tenant_id,
        transportId: r.transport_id,
        transportKind: r.kind,
        reason: r.status_reason,
      }));
    },

    async sendTotalsSince(since) {
      const rows = await db.execute<{ tenant_id: string; sent: number; failed: number }>(sql`
        SELECT tenant_id,
          count(*) FILTER (WHERE status = 'sent' AND sent_at >= ${since})::int AS sent,
          count(*) FILTER (WHERE status = 'failed' AND updated_at >= ${since})::int AS failed
        FROM lifecycle_messages
        WHERE (status = 'sent' AND sent_at >= ${since}) OR (status = 'failed' AND updated_at >= ${since})
        GROUP BY tenant_id
        ORDER BY tenant_id
      `);
      return rows.rows.map((r) => ({ tenantId: r.tenant_id, sent: Number(r.sent), failed: Number(r.failed) }));
    },

    async pendingApprovals() {
      const rows = await db.execute<{ tenant_id: string; pending: number; oldest_at: Date | string | null }>(sql`
        SELECT tenant_id, count(*)::int AS pending, min(created_at) AS oldest_at
        FROM lifecycle_messages
        WHERE status = 'pending_approval'
        GROUP BY tenant_id
        ORDER BY tenant_id
      `);
      return rows.rows.map((r) => ({
        tenantId: r.tenant_id,
        pending: Number(r.pending),
        oldestAt: r.oldest_at === null ? null : new Date(r.oldest_at),
      }));
    },

    async listProducts() {
      return db
        .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
        .from(tenants)
        .orderBy(sql`${tenants.createdAt} ASC NULLS LAST`, asc(tenants.id));
    },

    async firstInstanceAdminEmail() {
      const rows = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.instanceRole, "admin"), isNull(users.deactivatedAt)))
        .orderBy(sql`${users.createdAt} ASC NULLS LAST`, asc(users.id))
        .limit(1);
      return rows[0]?.email ?? null;
    },
  };
}
