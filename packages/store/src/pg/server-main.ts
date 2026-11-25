/**
 * Postgres implementation of the queries used by apps/server/src/main.ts.
 */
import { eq } from "drizzle-orm";
import { tenants, users } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { BootstrapSeedResult, ServerMainQueries } from "../areas/server-main.js";

export function pgServerMain(db: PgDb): ServerMainQueries {
  return {
    async bootstrapSeed(normalizedEmail) {
      const result: BootstrapSeedResult = { freshInstall: false, insertedTenant: false, tenantId: null };

      await db.transaction(async (tx) => {
        // Fast-path: if any tenant exists, nothing to do.
        const existing = await tx
          .select({ id: tenants.id })
          .from(tenants)
          .limit(1);
        if (existing.length > 0) return;

        result.freshInstall = true;

        // Attempt to insert the seed tenant. ON CONFLICT (slug) DO NOTHING means
        // exactly one of N concurrent callers inserts; the rest skip silently.
        const inserted = await tx
          .insert(tenants)
          .values({ name: "Default", slug: "default", plan: "free" })
          .onConflictDoNothing()
          .returning({ id: tenants.id });

        // Resolve the tenant id whether we inserted or lost the race.
        const tenantId =
          inserted.length > 0
            ? inserted[0]!.id
            : (
                await tx
                  .select({ id: tenants.id })
                  .from(tenants)
                  .where(eq(tenants.slug, "default"))
                  .limit(1)
              )[0]!.id;

        // If SEED_ADMIN_EMAIL is set, create the owner user (automated path).
        if (normalizedEmail) {
          await tx
            .insert(users)
            .values({ tenantId, email: normalizedEmail, role: "owner" })
            .onConflictDoNothing();
        }

        result.insertedTenant = inserted.length > 0;
        result.tenantId = tenantId;
      });

      return result;
    },

    async hasAnyUser() {
      const userCount = await db
        .select({ id: users.id })
        .from(users)
        .limit(1);
      return userCount.length > 0;
    },
  };
}
