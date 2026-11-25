/**
 * Postgres implementation of the queries used by packages/api/src/http/session.ts.
 */
import { eq } from "drizzle-orm";
import { sessions, tenants, users } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiSessionQueries } from "../areas/api-session.js";

export function pgApiSession(db: PgDb): ApiSessionQueries {
  return {
    async findSessionWithTenantAndUser(sessionId) {
      // Session + tenant + user in one query. The user join makes a session whose
      // user row is gone unusable; deactivated users cannot authenticate.
      const rows = await db
        .select({
          sessionUserId: sessions.userId,
          sessionExpiresAt: sessions.expiresAt,
          tenantId: tenants.id,
          tenantSlug: tenants.slug,
          userRole: users.role,
          userDeactivatedAt: users.deactivatedAt,
        })
        .from(sessions)
        .innerJoin(tenants, eq(sessions.tenantId, tenants.id))
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
