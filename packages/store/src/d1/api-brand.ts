/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-brand.ts.
 *
 * Logo bytes are a BLOB (at most 256 KB, far below the D1 row limit).
 * saveLogo and deleteLogo are one db.batch() each (atomic), where Postgres
 * uses a transaction.
 */
import { and, eq } from "drizzle-orm";
import { brandAssets, tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiBrandQueries, BrandProductRow } from "../areas/api-brand.js";

const LOGO = "logo";

export function d1ApiBrand(db: D1Db): ApiBrandQueries {
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

    async getLogo(tenantId) {
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
        .where(and(eq(brandAssets.tenantId, tenantId), eq(brandAssets.kind, LOGO)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const b = row.bytes as Uint8Array;
      return { ...row, bytes: new Uint8Array(b.buffer, b.byteOffset, b.byteLength) };
    },

    async saveLogo({ tenantId, logo, settings, now }) {
      const values = { ...logo, bytes: Buffer.from(logo.bytes), updatedAt: now };
      await db.batch([
        db
          .insert(brandAssets)
          .values({ tenantId, kind: LOGO, ...values })
          .onConflictDoUpdate({ target: [brandAssets.tenantId, brandAssets.kind], set: values }),
        db.update(tenants).set({ settings }).where(eq(tenants.id, tenantId)),
      ]);
    },

    async deleteLogo({ tenantId, settings }) {
      const del = db
        .delete(brandAssets)
        .where(and(eq(brandAssets.tenantId, tenantId), eq(brandAssets.kind, LOGO)))
        .returning({ kind: brandAssets.kind });
      if (!settings) return (await del).length > 0;
      const [deleted] = await db.batch([del, db.update(tenants).set({ settings }).where(eq(tenants.id, tenantId))]);
      return (deleted as unknown[]).length > 0;
    },
  };
}
