/**
 * What the dashboard opens on (multi-product instances). Pure logic, no DOM.
 *
 * Only active (non-archived) products count:
 *   - a product named in the URL (`?product=`) or chosen earlier in this tab:
 *     open the shell on it, as before
 *   - exactly one active product: open it, switching to it when the current
 *     product (the stored selection or the home product) is another one, for
 *     example an archived home product
 *   - two or more: show the product picker
 *   - none: the picker (with its create action) for instance admins, the
 *     shell on the current product for everyone else
 */
import type { ProductSummary } from "./api.js";

export type EntryDecision =
  | { kind: "shell" }
  | { kind: "switch"; product: ProductSummary }
  | { kind: "picker" };

export interface EntryInput {
  products: ProductSummary[];
  instanceAdmin: boolean;
  /** The product the session currently acts on (GET /auth/me tenantId). */
  currentProductId: string;
  /** The URL names a product (`?product=`). */
  productInUrl: boolean;
  /** A product was already chosen in this tab. */
  pickedThisSession: boolean;
}

export function activeProducts(products: ProductSummary[]): ProductSummary[] {
  return products.filter((p) => !p.archived);
}

export function decideEntry(input: EntryInput): EntryDecision {
  if (input.productInUrl || input.pickedThisSession) return { kind: "shell" };

  const active = activeProducts(input.products);
  if (active.length === 1) {
    const only = active[0]!;
    return only.id === input.currentProductId ? { kind: "shell" } : { kind: "switch", product: only };
  }
  if (active.length >= 2) return { kind: "picker" };
  return input.instanceAdmin ? { kind: "picker" } : { kind: "shell" };
}

/**
 * The product the picker highlights and focuses first: the last chosen one
 * (remembered slug) when it is still listed, else the current product, else
 * the first active product. Archived products are highlighted only when the
 * archived group is the whole list.
 */
export function highlightedProduct(
  products: ProductSummary[],
  rememberedSlug: string | null,
  currentProductId: string,
): ProductSummary | null {
  const active = activeProducts(products);
  const pool = active.length > 0 ? active : products;
  return (
    pool.find((p) => p.slug === rememberedSlug) ??
    pool.find((p) => p.id === currentProductId) ??
    pool[0] ??
    null
  );
}

/** Two-letter monogram for a product card: "Acme Billing" -> "AB", "acme" -> "AC". */
export function productMonogram(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length >= 2 ? words[0]!.charAt(0) + words[1]!.charAt(0) : words[0]!.slice(0, 2);
  return letters.toUpperCase();
}

export type FocusKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

/**
 * Next focused card for an arrow key, from the cards' on-screen positions
 * (so a grid of any column count behaves like a grid). Left and right move
 * through the reading order; up and down move to the nearest card in the
 * row above or below. Stays put at the edges.
 */
export function nextFocusIndex(
  rects: Array<{ top: number; left: number }>,
  index: number,
  key: FocusKey,
): number {
  const last = rects.length - 1;
  if (last < 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  if (key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "ArrowRight") return Math.min(last, index + 1);

  const from = rects[index];
  if (!from) return 0;
  const down = key === "ArrowDown";
  let best = index;
  let bestRow = Infinity;
  let bestCol = Infinity;
  rects.forEach((r, i) => {
    const dy = down ? r.top - from.top : from.top - r.top;
    if (dy <= 1) return; // same row (sub-pixel tolerance) or the wrong direction
    const dx = Math.abs(r.left - from.left);
    if (dy < bestRow - 1 || (Math.abs(dy - bestRow) <= 1 && dx < bestCol)) {
      best = i;
      bestRow = dy;
      bestCol = dx;
    }
  });
  return best;
}

/** The sidebar switcher offers a filter field above this many products. */
export const SWITCHER_FILTER_THRESHOLD = 6;

/**
 * Products the sidebar switcher lists: active products only (archived ones
 * open from the picker's "Archived" group or Settings, Products), narrowed
 * by a case-insensitive filter on name, slug and public host.
 */
export function switcherProducts(products: ProductSummary[], query: string): ProductSummary[] {
  const q = query.trim().toLowerCase();
  const active = activeProducts(products);
  if (!q) return active;
  return active.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.slug.includes(q) ||
      (p.public_host?.includes(q) ?? false),
  );
}
