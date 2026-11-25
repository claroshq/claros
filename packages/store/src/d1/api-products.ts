/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-products.ts.
 *
 * - Orderings put NULL created_at last, as Postgres ASC does.
 * - create: the Postgres transaction is one D1 batch. The tenant insert is
 *   ON CONFLICT (slug) DO NOTHING with an id generated here; the owner
 *   membership selects that tenant row, so it is written only when this
 *   caller created the product.
 * - update: a duplicate public host is SQLite's UNIQUE constraint error on
 *   tenants.public_host (index uq_tenants_public_host), mapped to
 *   "public_host_taken" like the Postgres unique violation.
 */
import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { memberships, tenants, users } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiProductsQueries, ProductRow } from "../areas/api-products.js";

const productColumns = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  locale: tenants.locale,
  publicHost: tenants.publicHost,
  archivedAt: tenants.archivedAt,
  createdAt: tenants.createdAt,
};

/** settings.brand.logo_url when it is a non-empty string, else null. */
const logoUrlColumn = sql<string | null>`CASE WHEN json_type(${tenants.settings}, '$.brand.logo_url') = 'text' THEN NULLIF(json_extract(${tenants.settings}, '$.brand.logo_url'), '') END`;

const productOrder = [sql`${tenants.createdAt} IS NULL`, asc(tenants.createdAt), asc(tenants.slug)] as const;

/** True for a SQLite UNIQUE constraint failure on tenants.public_host. */
function isPublicHostConflict(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    const message = String((e as { message?: unknown }).message ?? "");
    if (message.includes("UNIQUE constraint failed: tenants.public_host")) return true;
  }
  return false;
}

export function d1ApiProducts(db: D1Db): ApiProductsQueries {
  return {
    async listForUser({ userId }) {
      return db
        .select({
          ...productColumns,
          logoUrl: logoUrlColumn,
          role: sql<string>`CASE WHEN ${users.tenantId} = ${tenants.id} THEN ${users.role} ELSE ${memberships.role} END`,
        })
        .from(tenants)
        .innerJoin(users, eq(users.id, userId))
        .leftJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.tenantId, tenants.id)))
        .where(or(isNotNull(memberships.userId), eq(users.tenantId, tenants.id)))
        .orderBy(...productOrder);
    },

    async listAll() {
      return db.select({ ...productColumns, logoUrl: logoUrlColumn }).from(tenants).orderBy(...productOrder);
    },

    async create({ name, slug, locale, ownerUserId }) {
      const id = crypto.randomUUID();
      const now = new Date();
      if (ownerUserId === null) {
        const rows = await db
          .insert(tenants)
          .values({ id, name, slug, locale, plan: "free", createdAt: now })
          .onConflictDoNothing({ target: tenants.slug })
          .returning(productColumns);
        return rows[0] ?? null;
      }
      const [inserted] = await db.batch([
        db
          .insert(tenants)
          .values({ id, name, slug, locale, plan: "free", createdAt: now })
          .onConflictDoNothing({ target: tenants.slug })
          .returning(productColumns),
        db
          .insert(memberships)
          .select(
            db
              .select({
                userId: sql<string>`${ownerUserId}`.as("user_id"),
                tenantId: tenants.id,
                role: sql<string>`'owner'`.as("role"),
                createdAt: sql<number>`${now.getTime()}`.as("created_at"),
              })
              .from(tenants)
              .where(eq(tenants.id, id)),
          )
          .onConflictDoNothing(),
      ]);
      return inserted[0] ?? null;
    },

    async update({ slug, name, locale, publicHost }) {
      const set: Partial<typeof tenants.$inferInsert> = {};
      if (name !== undefined) set.name = name;
      if (locale !== undefined) set.locale = locale;
      if (publicHost !== undefined) set.publicHost = publicHost;
      try {
        const [product] = await db
          .update(tenants)
          .set({ ...set, configVersion: sql`${tenants.configVersion} + 1` })
          .where(eq(tenants.slug, slug))
          .returning(productColumns);
        return product ? { ok: true as const, product } : { ok: false as const, reason: "not_found" as const };
      } catch (err) {
        if (isPublicHostConflict(err)) return { ok: false as const, reason: "public_host_taken" as const };
        throw err;
      }
    },

    async setArchived({ slug, archivedAt }) {
      const [product] = await db
        .update(tenants)
        .set({ archivedAt })
        .where(eq(tenants.slug, slug))
        .returning(productColumns);
      return (product as ProductRow | undefined) ?? null;
    },
  };
}
