import { blob, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

/** Uploaded brand images per product (v0.8.5). See ../schema/brand-assets.ts. */
export const brandAssets = sqliteTable(
  "brand_assets",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: text("kind").notNull(),
    contentType: text("content_type").notNull(),
    bytes: blob("bytes", { mode: "buffer" }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sha256: text("sha256").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ name: "brand_assets_pkey", columns: [table.tenantId, table.kind] })],
);
