/**
 * Postgres implementation of the queries used by packages/api/src/http/session.ts.
 */
import { and, eq, sql } from "drizzle-orm";
import { sessions, tenants, users } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiSessionQueries } from "../areas/api-session.js";

export function pgApiSession(db: PgDb): ApiSessionQueries {
  return {
    async findSessionWithTenantAndUser(sessionId, productSlug = null) {
      // Session + product + user in one query. The user join makes a session whose
      // user row is gone unusable; deactivated users cannot authenticate (the
      // caller checks userDeactivatedAt).
      //
      // Effective role in the product: instance admins act as owner; in the
      // home product (users.tenant_id) users.role decides, as in v0.6; in any
      // other product the membership row does. No role means no access: no row.
      const effectiveRole = sql<string | null>`CASE
        WHEN ${users.instanceRole} = 'admin' THEN 'owner'
        WHEN ${users.tenantId} = ${tenants.id} THEN ${users.role}
        ELSE (SELECT m.role FROM memberships m WHERE m.user_id = ${users.id} AND m.tenant_id = ${tenants.id})
      END`;
      const rows = await db
        .select({
          sessionUserId: sessions.userId,
          sessionExpiresAt: sessions.expiresAt,
          tenantId: tenants.id,
          tenantSlug: tenants.slug,
          userRole: sql<string>`${effectiveRole}`,
          userDeactivatedAt: users.deactivatedAt,
          userInstanceRole: users.instanceRole,
          tenantArchivedAt: tenants.archivedAt,
        })
        .from(sessions)
        .innerJoin(
          tenants,
          productSlug !== null ? eq(tenants.slug, productSlug) : eq(sessions.tenantId, tenants.id),
        )
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(eq(sessions.id, sessionId), sql`(${effectiveRole}) IS NOT NULL`))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
