/**
 * Product selection (multi-product instances).
 *
 * The dashboard acts on one product at a time. The selection is sent as the
 * X-Claros-Product header on every API call; the server falls back to the
 * session's product when it is absent. Sources, in order:
 *   1. `?product=<slug>` in the page URL (wins, and is remembered)
 *   2. the slug remembered in localStorage
 *   3. none: the session's product (single-product installs never set one)
 */

export const PRODUCT_HEADER = "X-Claros-Product";
const STORAGE_KEY = "claros-product";

function readStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(slug: string | null): void {
  try {
    if (slug) localStorage.setItem(STORAGE_KEY, slug);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable: the selection lasts for this page only
  }
}

/** The selected product slug, or null for the session's product. */
export function selectedProductSlug(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("product")?.trim();
  if (fromUrl) {
    if (fromUrl !== readStorage()) writeStorage(fromUrl);
    return fromUrl;
  }
  return readStorage();
}

/** Request init with the product header added (when a product is selected). */
export function withProduct(init: RequestInit = {}): RequestInit {
  const slug = selectedProductSlug();
  if (!slug) return { credentials: "include", ...init };
  const headers = new Headers(init.headers);
  headers.set(PRODUCT_HEADER, slug);
  return { credentials: "include", ...init, headers };
}

/**
 * Switch to another product. Reloads the app on /home so no data of the
 * previous product survives in the query cache.
 */
export function switchProduct(slug: string | null): void {
  writeStorage(slug);
  window.location.assign("/home");
}

/**
 * Forget a selection the server refused (product removed, archived away,
 * or membership revoked). Returns true when there was one to forget.
 */
export function clearRefusedProduct(): boolean {
  if (!selectedProductSlug()) return false;
  writeStorage(null);
  return true;
}
