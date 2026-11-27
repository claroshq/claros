/**
 * Queries used by packages/api/src/routes/brand.ts (uploaded brand logo:
 * upload and delete under /v1/settings/brand/logo, public serving under
 * /brand). Implementations: ../pg/api-brand.ts and ../d1/api-brand.ts.
 */

/**
 * Kinds of stored brand image: the logo, and the version of it shown when
 * mail is read in dark mode.
 */
export type BrandAssetKind = "logo" | "logo_dark";

/** A stored brand image. */
export interface BrandAssetRow {
  contentType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  /** Hex SHA-256 of bytes. */
  sha256: string;
  updatedAt: Date;
}

/** A product as the brand routes need it. */
export interface BrandProductRow {
  id: string;
  slug: string;
  publicHost: string | null;
  settings: unknown;
}

export interface ApiBrandQueries {
  /** The product by id, or null. */
  findProduct(tenantId: string): Promise<BrandProductRow | null>;
  /** The product whose public_host is this host (lowercase), or null. */
  findProductByPublicHost(host: string): Promise<BrandProductRow | null>;
  /** The product with this slug, or null. */
  findProductBySlug(slug: string): Promise<BrandProductRow | null>;
  /** The product's uploaded image of this kind (default the logo), or null. */
  getLogo(tenantId: string, kind?: BrandAssetKind): Promise<BrandAssetRow | null>;
  /**
   * Store (insert or replace) the product's image of this kind (default the
   * logo) and replace its settings JSON, as one atomic unit.
   */
  saveLogo(input: {
    tenantId: string;
    kind?: BrandAssetKind;
    logo: Omit<BrandAssetRow, "updatedAt">;
    settings: Record<string, unknown>;
    now: Date;
  }): Promise<void>;
  /**
   * Delete the product's image of this kind (default the logo) and, when
   * settings is given, replace its settings JSON, as one atomic unit. True
   * when the image existed.
   */
  deleteLogo(input: { tenantId: string; kind?: BrandAssetKind; settings?: Record<string, unknown> }): Promise<boolean>;
}
