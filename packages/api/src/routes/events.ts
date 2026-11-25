/**
 * Events routes (dashboard operator scope).
 *
 * Registered under the /v1 prefix inside the authenticated scope in app.ts,
 * which enforces request.tenant !== null before any route handler runs.
 *
 * Endpoints:
 *   GET /v1/events/names  distinct track-event names seen recently
 */
import { RoleRouter } from "../http/router.js";
import { storeFor } from "@claros/store";

export default function eventsRoutes() {
  const r = new RoleRouter();
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
  r.get("/names", "member", async (c) => {
    const db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const eventNames = await storeFor(db).apiEvents.listRecentTrackEventNames(tenantId);

    return c.json({ event_names: eventNames });
  });
  return r.app;
}
