/**
 * Topics (G8a) and transport routing (G26, D16): pure decisions shared by the
 * drain, the settings API and the unsubscribe page. No I/O.
 */

export const TOPIC_KINDS = ["marketing", "lifecycle", "transactional"] as const;
export type TopicKind = (typeof TOPIC_KINDS)[number];

export const TRANSPORT_KINDS = ["resend", "smtp", "cloudflare"] as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

/** Which route a message takes: transactional-kind topics use the transactional route. */
export type TransportRoute = "default" | "transactional";

/** tenants.settings.transport_routing: transport ids. */
export interface TransportRouting {
  transactional?: string;
  default?: string;
}

/** Topic slugs: 1 to 63 characters of [a-z0-9_-], starting with a letter or digit. */
export const TOPIC_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function isTopicKind(v: unknown): v is TopicKind {
  return typeof v === "string" && (TOPIC_KINDS as readonly string[]).includes(v);
}

export function isTransportKind(v: unknown): v is TransportKind {
  return typeof v === "string" && (TRANSPORT_KINDS as readonly string[]).includes(v);
}

/** The route for a message: 'transactional' for a transactional-kind topic, else 'default'. */
export function routeForTopicKind(topicKind: string | null | undefined): TransportRoute {
  return topicKind === "transactional" ? "transactional" : "default";
}

/**
 * Pick the transport for a route among a product's active transports
 * (oldest first):
 *   - default: routing.default when it names an active transport, else the
 *     oldest active transport (the single active transport of a product that
 *     never configured routing, as before multiple transports).
 *   - transactional: routing.transactional when active, else the default.
 */
export function selectTransport<T extends { id: string }>(
  activeOldestFirst: readonly T[],
  routing: TransportRouting,
  route: TransportRoute,
): T | null {
  const byId = (id: string | undefined) => (id ? activeOldestFirst.find((t) => t.id === id) ?? null : null);
  const fallback = byId(routing.default) ?? activeOldestFirst[0] ?? null;
  if (route === "transactional") return byId(routing.transactional) ?? fallback;
  return fallback;
}

/**
 * Hard guard (D16, default deny): a `cloudflare` transport may send only
 * messages whose topic kind is 'transactional'. Cloudflare's terms do not
 * allow marketing mail.
 */
export function transportPolicyAllows(transportKind: string | null | undefined, topicKind: string | null | undefined): boolean {
  if (transportKind !== "cloudflare") return true;
  return topicKind === "transactional";
}

/**
 * Topic gate: true when the contact must not receive a message of this
 * topic. Transactional topics ignore topic unsubscribes (suppressions are
 * checked separately and always win).
 */
export function topicBlocks(gate: { kind: string; defaultSubscribed: boolean; status: string | null }): boolean {
  if (gate.kind === "transactional") return false;
  if (gate.status === "unsubscribed") return true;
  if (gate.status === null && gate.defaultSubscribed === false) return true;
  return false;
}

/** D18: RFC 8058 List-Unsubscribe headers on every message whose topic kind is not 'transactional'. */
export function carriesListUnsubscribe(topicKind: string | null | undefined): boolean {
  return topicKind !== "transactional";
}
