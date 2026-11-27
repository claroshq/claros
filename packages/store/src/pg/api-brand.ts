/**
 * Postgres implementation of the queries in ../areas/api-brand.ts.
 * Logo bytes are a bytea column (drizzle/schema/brand-assets.ts).
 */
import { and, eq } from "drizzle-orm";
import { brandAssets, tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiBrandQueries, BrandProductRow } from "../areas/api-brand.js";


export function pgApiBrand(db: PgDb): ApiBrandQueries {
  const product = async (where: ReturnType<typeof eq>): Promise<BrandProductRow | null> => {
    const rows = await db
      .select({ id: tenants.id, slug: tenants.slug, publicHost: tenants.publicHost, settings: tenants.settings })
      .from(tenants)
      .where(where)
      .limit(1);
    return rows[0] ?? null;
  };

  return {
    findProduct: (tenantId) => product(eq(tenants.id, tenantId)),
    findProductByPublicHost: (host) => product(eq(tenants.publicHost, host)),
    findProductBySlug: (slug) => product(eq(tenants.slug, slug)),

    async getLogo(tenantId, kind = "logo") {
      const rows = await db
        .select({
          contentType: brandAssets.contentType,
          bytes: brandAssets.bytes,
          width: brandAssets.width,
          height: brandAssets.height,
          sha256: brandAssets.sha256,
          updatedAt: brandAssets.updatedAt,
        })
        .from(brandAssets)
        .where(and(eq(brandAssets.tenantId, tenantId), eq(brandAssets.kind, kind)))
        .limit(1);
      return rows[0] ?? null;
    },

    async saveLogo({ tenantId, kind = "logo", logo, settings, now }) {
      const values = { ...logo, updatedAt: now };
      await db.transaction(async (tx) => {
        await tx
          .insert(brandAssets)
          .values({ tenantId, kind, ...values })
          .onConflictDoUpdate({ target: [brandAssets.tenantId, brandAssets.kind], set: values });
        await tx.update(tenants).set({ settings }).where(eq(tenants.id, tenantId));
      });
    },

    async deleteLogo({ tenantId, kind = "logo", settings }) {
      return db.transaction(async (tx) => {
        const deleted = await tx
          .delete(brandAssets)
          .where(and(eq(brandAssets.tenantId, tenantId), eq(brandAssets.kind, kind)))
          .returning({ kind: brandAssets.kind });
        if (settings) await tx.update(tenants).set({ settings }).where(eq(tenants.id, tenantId));
        return deleted.length > 0;
      });
    },
  };
}
