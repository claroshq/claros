/**
 * Queries used by packages/api/src/routes/config.ts (G2 config as code).
 */
import type { ConfigOp, ConfigState } from "@claros/core";

export interface ApiConfigQueries {
  /** The product's current state as config planning reads it; null when the product does not exist. */
  loadConfigState(tenantId: string): Promise<ConfigState | null>;
  /**
   * Apply operations in order, in one atomic unit, and bump
   * tenants.config_version. `upsertEndpoint.secret` is the encrypted
   * envelope. Refused (conflict, nothing written) when config_version is no
   * longer `expectedVersion` (another apply won). Returns the new version.
   */
  applyConfigOps(input: {
    tenantId: string;
    ops: ConfigOp[];
    expectedVersion: number;
    now: Date;
  }): Promise<{ ok: true; configVersion: number } | { ok: false; conflict: true }>;
  /**
   * G3: rebuild the product's contact_dates index from contact properties for
   * the declared date traits (after settings.date_traits changed). Idempotent,
   * paged; not one atomic unit. Returns the number of date rows written.
   */
  reindexContactDates(input: { tenantId: string; properties: readonly string[]; now: Date }): Promise<number>;
}
