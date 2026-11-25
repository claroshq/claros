/**
 * Queries used by packages/worker/src/transport-resolver.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-transport-resolver.ts (Postgres) and
 * ../d1/worker-transport-resolver.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A transport_configs row (config is the encrypted envelope as text). */
export interface WorkerTransportConfigRow {
  provider: string;
  config: string;
  from_email: string;
  from_name: string | null;
}

/** An active transport with what routing and sending need. */
export interface WorkerActiveTransportRow extends WorkerTransportConfigRow {
  id: string;
  /** resend | smtp | cloudflare (falls back to provider on rows written before kind existed). */
  kind: string;
  reply_to: string | null;
  daily_limit: number | null;
}

/** tenants.settings.transport_routing (transport ids), absent keys when unset. */
export interface WorkerTransportRouting {
  transactional?: string;
  default?: string;
}

export interface WorkerTransportResolverQueries {
  /** The tenant's active transport config (the oldest when several are active), or null when none is active. */
  getActiveTransportConfig(tenantId: string): Promise<WorkerTransportConfigRow | null>;
  /** Every active transport of the tenant, oldest first (created_at, then id). */
  listActiveTransports(tenantId: string): Promise<WorkerActiveTransportRow[]>;
  /** The tenant's transport routing from settings ({} when unset or the tenant does not exist). */
  getTransportRouting(tenantId: string): Promise<WorkerTransportRouting>;
}
