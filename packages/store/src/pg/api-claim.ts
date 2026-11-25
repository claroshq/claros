/**
 * Postgres implementation of the queries used by packages/api/src/routes/claim.ts.
 */
import { users, tenants, sessions, memberships } from "@claros/db/schema";
import { eq } from "drizzle-orm";
import type { PgDb } from "./db.js";
import type { ApiClaimQueries } from "../areas/api-claim.js";

export function pgApiClaim(db: PgDb): ApiClaimQueries {
  return {
    async anyUserExists() {
      const existingUsers = await db.select({ id: users.id }).from(users).limit(1);
      return existingUsers.length > 0;
    },

    async findDefaultTenantId() {
      const tenantRows = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, "default"))
        .limit(1);
      return tenantRows[0]?.id ?? null;
    },

    async createOwnerUser({ tenantId, email }) {
      return db.transaction(async (tx) => {
        const [newUser] = await tx
          .insert(users)
          .values({ tenantId, email, role: "owner", instanceRole: "admin" })
          .onConflictDoNothing()
          .returning({ id: users.id });
        if (!newUser) return null;
        await tx
          .insert(memberships)
          .values({ userId: newUser.id, tenantId, role: "owner" })
          .onConflictDoNothing();
        return newUser.id;
      });
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
