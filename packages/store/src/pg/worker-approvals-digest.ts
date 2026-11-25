/**
 * Postgres implementation of ../areas/worker-approvals-digest.ts.
 */
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { lifecycleMessages, memberships, tenantDailyUsage, tenants, users } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { WorkerApprovalsDigestQueries } from "../areas/worker-approvals-digest.js";

export function pgWorkerApprovalsDigest(db: PgDb): WorkerApprovalsDigestQueries {
  return {
    async listActiveProducts() {
      return db
        .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, settings: tenants.settings })
        .from(tenants)
        .where(isNull(tenants.archivedAt))
        .orderBy(tenants.id);
    },

    async claimDigest({ tenantId, day, now }) {
      // Insert the day's row with digest_sent_at, or set it when the row
      // exists without one; a second claim matches no row.
      const rows = await db
        .insert(tenantDailyUsage)
        .values({ tenantId, day, llmTokens: 0, digestSentAt: now })
        .onConflictDoUpdate({
          target: [tenantDailyUsage.tenantId, tenantDailyUsage.day],
          set: { digestSentAt: now },
          setWhere: sql`${tenantDailyUsage.digestSentAt} IS NULL`,
        })
        .returning({ day: tenantDailyUsage.day });
      return rows.length > 0;
    },

    async countPendingApprovals(tenantId) {
      const rows = await db
        .select({ n: count() })
        .from(lifecycleMessages)
        .where(and(eq(lifecycleMessages.tenantId, tenantId), eq(lifecycleMessages.status, "pending_approval")));
      return Number(rows[0]?.n ?? 0);
    },

    async listOwnerEmails(tenantId) {
      const rows = await db
        .select({ email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, "owner"), isNull(users.deactivatedAt)));
      return [...new Set(rows.map((r) => r.email))].sort();
    },
  };
}
