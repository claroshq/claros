/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-session.ts.
 *
 * Same single query as Postgres: session joined to the product (by slug when
 * given, else the session's tenant) and the user, with the effective role
 * (instance admin -> owner, home product -> users.role, else the membership
 * role) and no row when there is no role.
 */
import { and, eq, sql } from "drizzle-orm";
import { sessions, tenants, users } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiSessionQueries } from "../areas/api-session.js";

export function d1ApiSession(db: D1Db): ApiSessionQueries {
  return {
    async findSessionWithTenantAndUser(sessionId, productSlug = null) {
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
