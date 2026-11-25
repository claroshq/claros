/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-instance.ts.
 *
 * listUsers orders NULL created_at last, as Postgres ASC does.
 */
import { asc, eq, sql } from "drizzle-orm";
import { instanceSettings, memberships, tenants, users } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiInstanceQueries, InstanceUserRow } from "../areas/api-instance.js";

export function d1ApiInstance(db: D1Db): ApiInstanceQueries {
  return {
    async listSettings() {
      return db
        .select({ key: instanceSettings.key, value: instanceSettings.value, updatedAt: instanceSettings.updatedAt })
        .from(instanceSettings)
        .orderBy(asc(instanceSettings.key));
    },

    async putSetting({ key, value, now }) {
      const [row] = await db
        .insert(instanceSettings)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: now } })
        .returning({ key: instanceSettings.key, value: instanceSettings.value, updatedAt: instanceSettings.updatedAt });
      return row!;
    },

    async listUsers() {
      // One row per (user, membership); folded per user below.
      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          instanceRole: users.instanceRole,
          homeTenantId: users.tenantId,
          deactivatedAt: users.deactivatedAt,
          createdAt: users.createdAt,
          mTenantId: memberships.tenantId,
          mRole: memberships.role,
          mSlug: tenants.slug,
        })
        .from(users)
        .leftJoin(memberships, eq(memberships.userId, users.id))
        .leftJoin(tenants, eq(tenants.id, memberships.tenantId))
        .orderBy(
          sql`${users.createdAt} IS NULL`,
          asc(users.createdAt),
          asc(users.id),
          sql`${tenants.slug} IS NULL`,
          asc(tenants.slug),
        );

      const out: InstanceUserRow[] = [];
      const byId = new Map<string, InstanceUserRow>();
      for (const r of rows) {
        let u = byId.get(r.id);
        if (!u) {
          u = {
            id: r.id,
            email: r.email,
            name: r.name,
            instanceRole: r.instanceRole,
            homeTenantId: r.homeTenantId,
            deactivatedAt: r.deactivatedAt,
            createdAt: r.createdAt,
            memberships: [],
          };
          byId.set(r.id, u);
          out.push(u);
        }
        if (r.mTenantId !== null && r.mRole !== null && r.mSlug !== null) {
          u.memberships.push({ tenantId: r.mTenantId, slug: r.mSlug, role: r.mRole });
        }
      }
      return out;
    },
  };
}
