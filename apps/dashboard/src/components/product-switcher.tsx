/**
 * Product switcher (multi-product instances).
 *
 * Renders only when the user can act on more than one product; a
 * single-product install shows nothing. Switching stores the choice and
 * reloads the app on the new product (see product.ts).
 */
import { useProducts } from "../products.js";
import { switchProduct } from "../product.js";
import { Select } from "./ui/select.js";

export function ProductSwitcher({ currentProductId }: { currentProductId: string }) {
  const { data } = useProducts();
  if (!data || data.products.length <= 1) return null;

  const current = data.products.find((p) => p.id === currentProductId);

  return (
    <div className="px-3 pb-3">
      <label
        htmlFor="product-switcher"
        className="mb-1 block px-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle-foreground"
      >
        Product
      </label>
      <Select
        id="product-switcher"
        value={current?.slug ?? ""}
        onChange={(e) => switchProduct(e.target.value)}
        className="h-8 text-[14px]"
      >
        {!current && <option value="">Select a product</option>}
        {data.products.map((p) => (
          <option key={p.id} value={p.slug}>
            {p.archived ? `${p.name} (archived)` : p.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
