/**
 * Product switcher (multi-product instances).
 *
 * Renders only when the user can act on more than one product; a
 * single-product install shows nothing. The trigger is a quiet one-line
 * select: a color dot (productHue, stable per product) and the open
 * product's name; it opens a menu of the active
 * products with a check on the open one, a filter field above
 * SWITCHER_FILTER_THRESHOLD products, and footer actions: "All products"
 * (the full-screen picker, /products) and "New product" for instance admins.
 *
 * Archived products are never listed here; they open from the picker's
 * "Archived" group or Settings, Products. When the open product is archived
 * the trigger says so with a tag.
 *
 * Switching stores the choice and reloads the app on the new product (see
 * product.ts).
 *
 * Accessibility: the trigger is a button with aria-haspopup="menu"; the
 * menu uses menuitemradio for products and menuitem for actions, with
 * aria-activedescendant (focus stays on the filter field or the menu).
 * Arrow keys, Home and End move, Enter activates, Escape closes and returns
 * focus to the trigger, Tab and a click outside close. Without a filter
 * field, typing a letter jumps to the next product starting with it.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronsUpDown, LayoutGrid, Plus } from "lucide-react";
import { useProducts } from "../products.js";
import { switchProduct } from "../product.js";
import { SWITCHER_FILTER_THRESHOLD, activeProducts, productHue, switcherProducts } from "../product-entry.js";
import type { ProductSummary } from "../api.js";
import { Badge } from "./ui/badge.js";
import { cn } from "@/lib/utils";

/** The product's identity dot; grey when archived or unknown. */
function ProductDot({ product }: { product?: ProductSummary }) {
  const color =
    product && !product.archived
      ? `oklch(var(--product-dot-l) var(--product-dot-c) ${productHue(product.id)})`
      : "var(--fg-subtle)";
  return <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

type Item =
  | { kind: "product"; key: string; product: ProductSummary }
  | { kind: "action"; key: string; label: string; icon: React.ElementType; run: () => void };

export function ProductSwitcher({ currentProductId }: { currentProductId: string }) {
  const navigate = useNavigate();
  const { data } = useProducts();
  const baseId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const products = useMemo(() => data?.products ?? [], [data]);
  const current = products.find((p) => p.id === currentProductId);
  const showFilter = activeProducts(products).length > SWITCHER_FILTER_THRESHOLD;
  const listed = useMemo(() => switcherProducts(products, query), [products, query]);

  const items: Item[] = useMemo(() => {
    const list: Item[] = listed.map((p) => ({ kind: "product", key: p.id, product: p }));
    list.push({
      kind: "action",
      key: "all",
      label: "All products",
      icon: LayoutGrid,
      run: () => navigate("/products"),
    });
    if (data?.instance_admin) {
      list.push({
        kind: "action",
        key: "new",
        label: "New product",
        icon: Plus,
        run: () => navigate("/products?new=1"),
      });
    }
    return list;
  }, [listed, data?.instance_admin, navigate]);

  // Opening: start on the open product, focus the filter field or the menu.
  useEffect(() => {
    if (!open) return;
    const i = items.findIndex((it) => it.kind === "product" && it.product.id === currentProductId);
    setActiveIndex(i >= 0 ? i : 0);
    (filterRef.current ?? menuRef.current)?.focus();
    // Only on open; typing in the filter resets the index itself.
  }, [open]);

  // A click outside closes.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!panelRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) {
        close(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Keep the highlighted item in view.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${baseId}-item-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, baseId]);

  if (!data || products.length <= 1) return null;

  function close(returnFocus: boolean) {
    setOpen(false);
    setQuery("");
    if (returnFocus) triggerRef.current?.focus();
  }

  function activate(item: Item | undefined) {
    if (!item) return;
    if (item.kind === "action") {
      close(false);
      item.run();
      return;
    }
    if (item.product.id === currentProductId) {
      close(true);
      return;
    }
    switchProduct(item.product.slug);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const last = items.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => (i >= last ? 0 : i + 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => (i <= 0 ? last : i - 1));
        return;
      case "Home":
        if (showFilter) return; // caret movement in the filter field
        e.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        if (showFilter) return;
        e.preventDefault();
        setActiveIndex(last);
        return;
      case "Enter":
        e.preventDefault();
        activate(items[activeIndex]);
        return;
      case "Escape":
        e.preventDefault();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
    }
    // Type-ahead without a filter field: jump to the next product starting with the key.
    if (!showFilter && e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      for (let step = 1; step <= items.length; step++) {
        const i = (activeIndex + step) % items.length;
        const it = items[i];
        if (it?.kind === "product" && it.product.name.toLowerCase().startsWith(ch)) {
          setActiveIndex(i);
          break;
        }
      }
    }
  }

  const menuId = `${baseId}-menu`;
  const activeId = items.length > 0 ? `${baseId}-item-${activeIndex}` : undefined;

  return (
    <div className="relative px-3 pb-3">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Product: ${current?.name ?? "none selected"}. Switch product`}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        title={current ? (current.public_host ?? current.slug) : undefined}
        className={cn(
          // Outer edge on the nav items' edge (wrapper px-3); 1px border + 11px
          // padding puts the dot on the 24px axis of the mark and nav icons.
          "flex h-11 w-full items-center gap-2.5 rounded-lg border bg-card px-[11px] text-left shadow-card transition-colors duration-(--dur-fast)",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          open ? "border-border-strong" : "border-border hover:border-border-strong",
        )}
      >
        <ProductDot product={current} />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">
          {current?.name ?? "Select a product"}
        </span>
        {current?.archived && (
          <Badge variant="muted" className="h-5 shrink-0 px-2 text-[12px]">
            archived
          </Badge>
        )}
        <ChevronsUpDown size={14} strokeWidth={1.5} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute left-3 right-3 top-full z-40 mt-1 overflow-hidden rounded-lg border border-border bg-card shadow-overlay"
        >
          {showFilter && (
            <div className="border-b border-border p-2">
              <input
                ref={filterRef}
                type="text"
                role="combobox"
                aria-label="Find a product"
                aria-controls={menuId}
                aria-expanded="true"
                aria-autocomplete="list"
                aria-activedescendant={activeId}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Find a product"
                className="h-8 w-full rounded-md border border-input bg-card px-2.5 text-[14px] text-foreground placeholder:text-subtle-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          )}
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="Switch product"
            tabIndex={showFilter ? -1 : 0}
            aria-activedescendant={showFilter ? undefined : activeId}
            onKeyDown={showFilter ? undefined : onKeyDown}
            className="max-h-[min(22rem,60vh)] overflow-y-auto py-1 focus-visible:outline-none"
          >
            {listed.length === 0 && (
              <p className="px-3 py-2 text-[14px] text-muted-foreground">No product matches.</p>
            )}
            {items.map((item, i) => {
              const highlighted = i === activeIndex;
              if (item.kind === "action") {
                const Icon = item.icon;
                const firstAction = i > 0 && items[i - 1]?.kind === "product";
                return (
                  <React.Fragment key={item.key}>
                    {(firstAction || (i === 0 && listed.length === 0)) && (
                      <div role="separator" className="my-1 border-t border-border" />
                    )}
                    <div
                      id={`${baseId}-item-${i}`}
                      role="menuitem"
                      onPointerMove={() => setActiveIndex(i)}
                      onClick={() => activate(item)}
                      className={cn(
                        "mx-1 flex cursor-pointer items-center gap-2 rounded-md px-[7px] py-1.5 text-[14px] font-medium text-muted-foreground",
                        highlighted && "bg-selected text-foreground",
                      )}
                    >
                      <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
                      {item.label}
                    </div>
                  </React.Fragment>
                );
              }
              const p = item.product;
              const isCurrent = p.id === currentProductId;
              return (
                <div
                  key={item.key}
                  id={`${baseId}-item-${i}`}
                  role="menuitemradio"
                  aria-checked={isCurrent}
                  onPointerMove={() => setActiveIndex(i)}
                  onClick={() => activate(item)}
                  className={cn(
                    "mx-1 flex cursor-pointer items-center gap-2 rounded-md px-[7px] py-1.5",
                    highlighted && "bg-selected",
                  )}
                  title={p.public_host ?? p.slug}
                >
                  <ProductDot product={p} />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[14px] leading-5 text-foreground",
                      isCurrent ? "font-semibold" : "font-medium",
                    )}
                  >
                    {p.name}
                  </span>
                  {isCurrent && (
                    <Check size={16} strokeWidth={1.5} className="shrink-0 text-accent-text" aria-hidden="true" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
