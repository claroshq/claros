/**
 * Queries used by packages/worker/src/scan-time-transitions.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-scan-time-transitions.ts (Postgres) and, later,
 * ../d1/worker-scan-time-transitions.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

export interface WorkerScanTimeTransitionsQueries {
  /** Tenants (id, settings) ordered by id; restricted to tenantIds when given and non-empty. */
  listTenants(tenantIds?: string[]): Promise<{ id: string; settings: unknown }[]>;
  /** One keyset page (by id, after afterId) of the tenant's contacts in the given lifecycle states. */
  listContactsInStatesPage(input: {
    tenantId: string;
    states: string[];
    afterId: string | null;
    limit: number;
  }): Promise<{ id: string; lifecycleState: string; lastSeenAt: Date | null }[]>;
  /**
   * Apply a lifecycle transition by compare-and-swap on the contact's current
   * state (fromState) and, only when the swap succeeded, write the scan audit
   * row. Returns whether the transition was applied (false: a concurrent
   * process already changed the state).
   */
  applyTimeTransition(input: {
    tenantId: string;
    contactId: string;
    fromState: string;
    toState: string;
    now: Date;
  }): Promise<boolean>;
}
