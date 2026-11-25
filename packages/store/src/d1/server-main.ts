/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/server-main.ts.
 *
 * bootstrapSeed: the Postgres transaction is one D1 batch (one SQLite
 * transaction; D1 serialises writes):
 *   1. read whether any tenant exists (freshInstall),
 *   2. insert the "default" tenant only when no tenant exists (ON CONFLICT
 *      DO NOTHING on slug), with an id generated here,
 *   3. read the default tenant's id,
 *   4. with an owner email: insert the owner user into that tenant only
 *      when step 2 inserted it (our tenant id exists), ON CONFLICT DO NOTHING,
 *   5. insert the owner membership only when step 4 inserted our user.
 * Because the batch is serialised, a concurrent caller sees the tenant of
 * the winner at step 1 and returns freshInstall false (Postgres may report
 * freshInstall true with insertedTenant false for a caller that lost the
 * slug conflict). Exactly one caller inserts; the seed is written once.
 */
import { sql } from "drizzle-orm";
import { users } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { BootstrapSeedResult, ServerMainQueries } from "../areas/server-main.js";
import { rawBatch } from "./raw-batch.js";

export function d1ServerMain(db: D1Db): ServerMainQueries {
  return {
    async bootstrapSeed(normalizedEmail) {
      const tenantId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const now = Date.now();
      const statements = [
        sql`SELECT EXISTS (SELECT 1 FROM tenants) AS any_tenant`,
        sql`INSERT INTO tenants (id, name, slug, plan, created_at)
            SELECT ${tenantId}, 'Default', 'default', 'free', ${now}
            WHERE NOT EXISTS (SELECT 1 FROM tenants)
            ON CONFLICT (slug) DO NOTHING
            RETURNING id`,
        sql`SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
      ];
      if (normalizedEmail) {
        statements.push(
          sql`INSERT INTO users (id, tenant_id, email, role, instance_role, created_at)
              SELECT ${userId}, id, ${normalizedEmail}, 'owner', 'admin', ${now}
              FROM tenants WHERE id = ${tenantId}
              ON CONFLICT DO NOTHING`,
          sql`INSERT INTO memberships (user_id, tenant_id, role, created_at)
              SELECT id, tenant_id, 'owner', ${now} FROM users WHERE id = ${userId}
              ON CONFLICT DO NOTHING`,
        );
      }
      const [anyRows, insertedRows, defaultRows] = await rawBatch(db, statements);

      const result: BootstrapSeedResult = { freshInstall: false, insertedTenant: false, tenantId: null };
      if (Number(anyRows![0]!.any_tenant) === 1) return result;
      result.freshInstall = true;
      result.insertedTenant = insertedRows!.length > 0;
      result.tenantId = (defaultRows![0]?.id as string | undefined) ?? null;
      return result;
    },

    async hasAnyUser() {
      const rows = await db.select({ id: users.id }).from(users).limit(1);
      return rows.length > 0;
    },
  };
}
