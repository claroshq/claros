import { pgTable, uuid, text, integer, timestamp, primaryKey, customType } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/** bytea as Uint8Array (node-postgres returns a Buffer, which is one). */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  },
});

/**
 * Uploaded brand images per product (v0.8.5): today only kind 'logo'.
 * The bytes live in the database on both backends (PNG or JPEG, at most
 * 256 KB, checked by the upload route). Served without auth at
 * /brand/logo on the product's public host and /brand/<slug>/logo on the
 * instance host (packages/api/src/routes/brand.ts).
 */
export const brandAssets = pgTable(
  "brand_assets",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: text("kind").notNull(),
    contentType: text("content_type").notNull(),
    bytes: bytea("bytes").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /** Hex SHA-256 of bytes; its prefix versions the public URL (?v=). */
    sha256: text("sha256").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ name: "brand_assets_pkey", columns: [table.tenantId, table.kind] })],
);
