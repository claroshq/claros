/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-claim.ts.
 *
 * createOwnerUser: one batch (one SQLite transaction). The user insert is
 * ON CONFLICT DO NOTHING with an id generated here; the membership insert
 * selects that user row, so it is written only when this caller's user was.
 */
import { users, tenants, sessions } from "@claros/db/schema-sqlite";
import { eq, sql } from "drizzle-orm";
import type { D1Db } from "./db.js";
import type { ApiClaimQueries } from "../areas/api-claim.js";
import { rawBatch } from "./raw-batch.js";

export function d1ApiClaim(db: D1Db): ApiClaimQueries {
  return {
    async anyUserExists() {
      const rows = await db.select({ id: users.id }).from(users).limit(1);
      return rows.length > 0;
    },

    async findDefaultTenantId() {
      const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, "default")).limit(1);
      return rows[0]?.id ?? null;
    },

    async createOwnerUser({ tenantId, email }) {
      const userId = crypto.randomUUID();
      const now = Date.now();
      const [inserted] = await rawBatch(db, [
        sql`INSERT INTO users (id, tenant_id, email, role, instance_role, created_at)
            VALUES (${userId}, ${tenantId}, ${email}, 'owner', 'admin', ${now})
            ON CONFLICT DO NOTHING
            RETURNING id`,
        sql`INSERT INTO memberships (user_id, tenant_id, role, created_at)
            SELECT id, tenant_id, 'owner', ${now} FROM users WHERE id = ${userId}
            ON CONFLICT DO NOTHING`,
      ]);
      return inserted!.length > 0 ? userId : null;
    },

    async createSession({ tenantId, userId, expiresAt }) {
      const [session] = await db
        .insert(sessions)
        .values({ tenantId, userId, expiresAt })
        .returning({ id: sessions.id });
      return session!.id;
    },
  };
}
