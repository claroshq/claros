/**
 * Events routes (dashboard operator scope).
 *
 * Registered under the /v1 prefix inside the authenticated scope in app.ts,
 * which enforces request.tenant !== null before any route handler runs.
 *
 * Endpoints:
 *   GET /v1/events/names  distinct track-event names seen recently
 */
import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "../plugins/db.js";

const eventsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /v1/events/names
   *
   * Distinct event_name values from track events received in the last 6
   * months, most frequent first, capped at 200. Backs the event-name
   * autosuggest in the flow editor. This is a hint list, not an exhaustive
   * registry: any string remains a valid event name.
   *
   * The received_at range keeps the scan on the recent monthly partitions
   * (events is PARTITION BY RANGE (received_at)); tenant_id is always the
   * first filter.
   */
  app.get("/names", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rows = (
      await db.execute<{ event_name: string }>(sql`
        SELECT event_name
        FROM events
        WHERE tenant_id = ${tenantId}
          AND type = 'track'
          AND event_name IS NOT NULL
          AND received_at >= now() - interval '6 months'
        GROUP BY event_name
        ORDER BY count(*) DESC, event_name ASC
        LIMIT 200
      `)
    ).rows;

    return { event_names: rows.map((r) => r.event_name) };
  });
};

export default eventsRoutes;
