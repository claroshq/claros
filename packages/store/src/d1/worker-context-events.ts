/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/worker-context-events.ts.
 *
 * `events` is one plain table on SQLite (no partitions); the received_at
 * bounds are kept so results match Postgres exactly. COUNT values are
 * returned as strings like the pg driver's bigint, timestamps as Date.
 * pg sorts NULL event names last in ASC order; SQLite needs NULLS LAST.
 */
import { sql } from "drizzle-orm";
import type { D1Db } from "./db.js";
import type { WorkerContextEventsQueries } from "../areas/worker-context-events.js";

export function d1WorkerContextEvents(db: D1Db): WorkerContextEventsQueries {
  return {
    async countCadenceWindows({ tenantId, contactId, now, w7Start, w14Start, receivedFrom }) {
      const nowMs = now.getTime();
      const w7 = w7Start.getTime();
      const w14 = w14Start.getTime();
      const rows = await db.all<{ current_7d: number; previous_7d: number }>(sql`
        SELECT
          COUNT(CASE WHEN timestamp >= ${w7} AND timestamp < ${nowMs} THEN 1 END) AS current_7d,
          COUNT(CASE WHEN timestamp >= ${w14} AND timestamp < ${w7} THEN 1 END) AS previous_7d
        FROM events
        WHERE contact_id  = ${contactId}
          AND tenant_id   = ${tenantId}
          AND received_at >= ${receivedFrom.getTime()}
          AND received_at  < ${nowMs}
      `);
      const r = rows[0]!;
      return { current_7d: String(r.current_7d), previous_7d: String(r.previous_7d) };
    },

    async listRecentEvents({ tenantId, contactId, receivedFrom, limit }) {
      const rows = await db.all<{ event_name: string | null; timestamp: number }>(sql`
        SELECT event_name, timestamp
        FROM events
        WHERE contact_id  = ${contactId}
          AND tenant_id   = ${tenantId}
          AND received_at >= ${receivedFrom.getTime()}
        ORDER BY timestamp DESC, event_name ASC NULLS LAST
        LIMIT ${limit}
      `);
      return rows.map((r) => ({ event_name: r.event_name, timestamp: new Date(Number(r.timestamp)) }));
    },

    async listMostUsedEventNames({ tenantId, contactId, now, since, receivedFrom, limit }) {
      const nowMs = now.getTime();
      const rows = await db.all<{ event_name: string; cnt: number }>(sql`
        SELECT event_name, COUNT(*) AS cnt
        FROM events
        WHERE contact_id  = ${contactId}
          AND tenant_id   = ${tenantId}
          AND event_name IS NOT NULL
          AND timestamp  >= ${since.getTime()}
          AND timestamp   < ${nowMs}
          AND received_at >= ${receivedFrom.getTime()}
          AND received_at  < ${nowMs}
        GROUP BY event_name
        ORDER BY cnt DESC, event_name ASC
        LIMIT ${limit}
      `);
      return rows.map((r) => ({ event_name: r.event_name, cnt: String(r.cnt) }));
    },
  };
}
