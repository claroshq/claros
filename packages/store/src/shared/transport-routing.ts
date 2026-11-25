/**
 * tenants.settings.transport_routing as plain values. Only string ids are
 * kept; anything else in the JSON is ignored.
 */
import type { WorkerTransportRouting } from "../areas/worker-transport-resolver.js";

export function routingFromSettings(settings: unknown): WorkerTransportRouting {
  const s = typeof settings === "string" ? safeParse(settings) : settings;
  if (!s || typeof s !== "object") return {};
  const routing = (s as Record<string, unknown>).transport_routing;
  if (!routing || typeof routing !== "object") return {};
  const r = routing as Record<string, unknown>;
  const out: WorkerTransportRouting = {};
  if (typeof r.transactional === "string" && r.transactional) out.transactional = r.transactional;
  if (typeof r.default === "string" && r.default) out.default = r.default;
  return out;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
