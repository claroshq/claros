/**
 * Queries used by packages/api/src/routes/products.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-products.ts (Postgres) and, later,
 * ../d1/api-products.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 *
 * Products are tenants (user-facing name "product").
 */

/** A product (tenant) as the products routes display it. */
export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  locale: string | null;
  publicHost: string | null;
  archivedAt: Date | null;
  createdAt: Date | null;
}

/**
 * A product in a list: the row plus its effective brand logo, the string in
 * settings.brand.logo_url (an uploaded logo's hosted URL or an external
 * URL), null when unset, empty or not a string.
 */
export type ProductListRow = ProductRow & { logoUrl: string | null };

export type ProductUpdateResult =
  | { ok: true; product: ProductRow }
  | { ok: false; reason: "not_found" | "public_host_taken" };

export interface ApiProductsQueries {
  /**
   * Products the user may act on, oldest first, with the user's role: the
   * home product (users.role) plus every tenant with a membership row
   * (membership role).
   */
  listForUser(args: { userId: string }): Promise<Array<ProductListRow & { role: string }>>;
  /** Every product of the instance, oldest first. */
  listAll(): Promise<ProductListRow[]>;
  /**
   * In one transaction: insert the product and the creator's owner
   * membership (none when ownerUserId is null: an instance key created
   * it). Null when the slug is taken.
   */
  create(args: { name: string; slug: string; locale: string | null; ownerUserId: string | null }): Promise<ProductRow | null>;
  /**
   * Update name / locale / public host of the product with this slug (fields
   * left undefined are kept) and bump config_version.
   */
  update(args: {
    slug: string;
    name?: string;
    locale?: string | null;
    publicHost?: string | null;
  }): Promise<ProductUpdateResult>;
  /** Set or clear archived_at of the product with this slug; null when it does not exist. */
  setArchived(args: { slug: string; archivedAt: Date | null }): Promise<ProductRow | null>;
}
