/**
 * Postgres implementation of the queries used by packages/api/src/routes/products.ts.
 */
import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { memberships, tenants, users } from "@claros/db/schema";
import type { PgDb } from "./db.js";
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
const logoUrlColumn = sql<string | null>`CASE WHEN jsonb_typeof(${tenants.settings} -> 'brand' -> 'logo_url') = 'string' THEN NULLIF(${tenants.settings} -> 'brand' ->> 'logo_url', '') END`;

/** True for a Postgres unique violation on the named constraint/index. */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = (err as { cause?: unknown })?.cause ?? err;
  const pgErr = e as { code?: string; constraint?: string };
  return pgErr?.code === "23505" && pgErr.constraint === constraint;
}

export function pgApiProducts(db: PgDb): ApiProductsQueries {
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
        .leftJoin(
          memberships,
          and(eq(memberships.userId, users.id), eq(memberships.tenantId, tenants.id)),
        )
        .where(or(isNotNull(memberships.userId), eq(users.tenantId, tenants.id)))
        .orderBy(asc(tenants.createdAt), asc(tenants.slug));
    },

    async listAll() {
      return db
        .select({ ...productColumns, logoUrl: logoUrlColumn })
        .from(tenants)
        .orderBy(asc(tenants.createdAt), asc(tenants.slug));
    },

    async create({ name, slug, locale, ownerUserId }) {
      return db.transaction(async (tx) => {
        const [product] = await tx
          .insert(tenants)
          .values({ name, slug, locale, plan: "free" })
          .onConflictDoNothing({ target: tenants.slug })
          .returning(productColumns);
        if (!product) return null;
        if (ownerUserId === null) return product;
        await tx
          .insert(memberships)
          .values({ userId: ownerUserId, tenantId: product.id, role: "owner" })
          .onConflictDoNothing();
        return product;
      });
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
        if (isUniqueViolation(err, "uq_tenants_public_host")) {
          return { ok: false as const, reason: "public_host_taken" as const };
        }
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
