/**
 * Queries used by packages/worker/src/transport-resolver.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-transport-resolver.ts (Postgres) and, later,
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

export interface WorkerTransportResolverQueries {
  /** The tenant's active transport config, or null when none is active. */
  getActiveTransportConfig(tenantId: string): Promise<WorkerTransportConfigRow | null>;
}
