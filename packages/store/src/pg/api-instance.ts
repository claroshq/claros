/**
 * Postgres implementation of the queries used by packages/api/src/routes/instance.ts.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { apiKeys, contacts, instanceSettings, memberships, tenants, users } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiInstanceQueries, InstanceKeyRow, InstanceUserRow } from "../areas/api-instance.js";

export function pgApiInstance(db: PgDb): ApiInstanceQueries {
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
        .orderBy(asc(users.createdAt), asc(users.id), asc(tenants.slug));

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

    async listInstanceKeys() {
      const rows = await db
        .select(instanceKeyColumns)
        .from(apiKeys)
        .where(and(eq(apiKeys.kind, "instance"), isNull(apiKeys.tenantId)))
        .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id));
      return rows.map(instanceKeyRow);
    },

    async createInstanceKey({ keyHash, prefix, label, scopes, now }) {
      const [row] = await db
        .insert(apiKeys)
        .values({ tenantId: null, keyHash, prefix, label, kind: "instance", scopes, createdAt: now })
        .returning(instanceKeyColumns);
      return instanceKeyRow(row!);
    },

    async revokeInstanceKey({ id, now }) {
      const where = and(eq(apiKeys.id, id), eq(apiKeys.kind, "instance"), isNull(apiKeys.tenantId));
      await db.update(apiKeys).set({ revokedAt: now }).where(and(where, isNull(apiKeys.revokedAt)));
      const rows = await db.select(instanceKeyColumns).from(apiKeys).where(where).limit(1);
      return rows[0] ? instanceKeyRow(rows[0]) : null;
    },

    async findPeopleByEmail(email) {
      return db
        .select({ tenantId: contacts.tenantId, tenantSlug: tenants.slug, contactId: contacts.id, externalId: contacts.externalId })
        .from(contacts)
        .innerJoin(tenants, eq(tenants.id, contacts.tenantId))
        .where(and(sql`${contacts.email} IS NOT NULL`, sql`lower(${contacts.email}) = lower(${email})`))
        .orderBy(asc(tenants.slug), asc(contacts.id));
    },
  };
}

const instanceKeyColumns = {
  id: apiKeys.id,
  prefix: apiKeys.prefix,
  label: apiKeys.label,
  scopes: apiKeys.scopes,
  lastUsedAt: apiKeys.lastUsedAt,
  createdAt: apiKeys.createdAt,
  revokedAt: apiKeys.revokedAt,
};

function instanceKeyRow(r: { id: string; prefix: string; label: string | null; scopes: unknown; lastUsedAt: Date | null; createdAt: Date | null; revokedAt: Date | null }): InstanceKeyRow {
  return { ...r, scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [] };
}
