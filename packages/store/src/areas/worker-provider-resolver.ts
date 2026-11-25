/**
 * Queries used by packages/worker/src/provider-resolver.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-provider-resolver.ts (Postgres) and, later,
 * ../d1/worker-provider-resolver.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** The tenant's active llm_configs row. */
export interface WorkerActiveLlmConfig {
  id: string;
  tenantId: string;
  provider: string;
  /** Encrypted JSON envelope. */
  config: string;
  isActive: boolean | null;
  createdAt: Date | null;
}

export interface WorkerProviderResolverQueries {
  /** The tenant's active LLM config, or null when none is active. */
  getActiveLlmConfig(tenantId: string): Promise<WorkerActiveLlmConfig | null>;
}
