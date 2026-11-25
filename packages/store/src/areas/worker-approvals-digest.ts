/**
 * Queries used by packages/worker/src/approvals-digest.ts (P5b): the daily
 * waiting-approvals mail to a product's owners (settings.approvals.daily_digest).
 */
export interface WorkerApprovalsDigestQueries {
  /** Products that are not archived, with their settings, ordered by id. */
  listActiveProducts(): Promise<Array<{ id: string; name: string; slug: string; settings: unknown }>>;
  /**
   * Claim the digest of a product for a (local) day: true exactly once per
   * (tenant, day), also under concurrent callers (one atomic upsert).
   */
  claimDigest(input: { tenantId: string; day: string; now: Date }): Promise<boolean>;
  /** Messages of the product waiting for approval (status pending_approval). */
  countPendingApprovals(tenantId: string): Promise<number>;
  /** Email addresses of the product's active owners (memberships role owner), sorted. */
  listOwnerEmails(tenantId: string): Promise<string[]>;
}
