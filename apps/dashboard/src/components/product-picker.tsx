/**
 * Product picker (multi-product instances).
 *
 * A full-screen page shown before the shell when the user can act on two or
 * more active products (see product-entry.ts), and from the sidebar switcher
 * ("All products", route /products). One card per product: monogram, name,
 * slug, public host, role. The last chosen product is highlighted and takes
 * the initial focus.
 *
 * Keyboard: arrow keys move between cards (grid aware), Home and End jump,
 * Enter opens the focused card, 1-9 open the matching active product.
 *
 * Archived products sit in a collapsed group and open read-only. Instance
 * admins get the "New product" action (the Settings, Products form).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Layers, LogOut, Plus } from "lucide-react";
import type { ProductSummary } from "../api.js";
import {
  activeProducts,
  highlightedProduct,
  nextFocusIndex,
  type FocusKey,
} from "../product-entry.js";
import { BrandLockup } from "./brand-lockup.js";
import { ProductAvatar } from "./product-avatar.js";
import { ThemeToggle } from "./theme-toggle.js";
import { PageHeader } from "./page-header.js";
import { EmptyState } from "./empty-state.js";
import { CreateProductForm } from "./create-product-form.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Skeleton } from "./ui/skeleton.js";
import { cn } from "@/lib/utils";

const FOCUS_KEYS = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

export interface PickerTarget {
  id: string;
  slug: string;
}

interface ProductPickerProps {
  /** null while the product list loads. */
  products: ProductSummary[] | null;
  instanceAdmin: boolean;
  currentProductId: string;
  rememberedSlug: string | null;
  /**
   * entry: shown on app open; the highlighted card reads "Last opened".
   * switch: opened from the sidebar; the open product reads "Current".
   */
  mode: "entry" | "switch";
  email: string;
  onChoose: (product: PickerTarget) => void;
  onSignOut: () => void;
  signingOut?: boolean;
  /** Open with the "New product" form shown (instance admins). */
  initialCreating?: boolean;
  /** Set when the product list failed to load. */
  error?: string | null;
  onRetry?: () => void;
}

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function ProductCard({
  product,
  shortcut,
  highlighted,
  marker,
  opening,
  disabled,
  onChoose,
  cardRef,
}: {
  product: ProductSummary;
  shortcut: number | null;
  highlighted: boolean;
  marker: string | null;
  opening: boolean;
  disabled: boolean;
  onChoose: () => void;
  cardRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <li>
      <button
        ref={cardRef}
        type="button"
        data-product-card
        onClick={onChoose}
        disabled={disabled}
        aria-keyshortcuts={shortcut ? String(shortcut) : undefined}
        aria-label={`Open ${product.name}${product.archived ? " (archived, read-only)" : ""}`}
        className={cn(
          "group flex w-full items-start gap-4 rounded-lg border p-4 text-left transition-colors duration-(--dur-fast)",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:pointer-events-none",
          highlighted
            ? "border-border-strong bg-card"
            : "border-border bg-background hover:border-border-strong hover:bg-card",
        )}
      >
        <ProductAvatar
          name={product.name}
          logoUrl={product.logo_url}
          tone={product.archived ? "muted" : highlighted ? "accent" : "neutral"}
        />

        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-[16px] font-semibold leading-6",
              product.archived ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {product.name}
          </span>
          <span className="block truncate font-mono text-[13px] leading-5 text-muted-foreground">
            {product.slug}
            {product.public_host && (
              <>
                <span aria-hidden="true" className="px-1.5 text-subtle-foreground">·</span>
                {product.public_host}
              </>
            )}
          </span>
          <span className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{roleLabel(product.role)}</Badge>
            {product.archived && <Badge variant="muted">Read-only</Badge>}
            {marker && <Badge variant="accent">{marker}</Badge>}
            {opening && <span className="text-[14px] text-muted-foreground">Opening...</span>}
          </span>
        </span>

        {shortcut !== null && (
          <kbd
            aria-hidden="true"
            className="hidden h-6 min-w-6 shrink-0 items-center justify-center rounded-sm border border-border px-1.5 font-mono text-[12px] text-subtle-foreground sm:inline-flex"
          >
            {shortcut}
          </kbd>
        )}
      </button>
    </li>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border px-1 font-mono text-[12px] text-muted-foreground">
      {children}
    </kbd>
  );
}

export function ProductPicker({
  products,
  instanceAdmin,
  currentProductId,
  rememberedSlug,
  mode,
  email,
  onChoose,
  onSignOut,
  signingOut = false,
  error = null,
  onRetry,
  initialCreating = false,
}: ProductPickerProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLButtonElement>(null);
  const [creatingOpen, setCreating] = useState(initialCreating);
  const creating = creatingOpen && instanceAdmin;
  const [openingId, setOpeningId] = useState<string | null>(null);

  const list = useMemo(() => products ?? [], [products]);
  const active = useMemo(() => activeProducts(list), [list]);
  const archived = useMemo(() => list.filter((p) => p.archived), [list]);
  const [showArchived, setShowArchived] = useState(false);
  const archivedOpen = showArchived || (products !== null && active.length === 0);

  const highlighted = useMemo(
    () => highlightedProduct(list, mode === "switch" ? null : rememberedSlug, currentProductId),
    [list, mode, rememberedSlug, currentProductId],
  );

  const choose = useCallback(
    (p: PickerTarget) => {
      if (openingId) return;
      setOpeningId(p.id);
      onChoose(p);
    },
    [onChoose, openingId],
  );

  // Initial focus on the highlighted card, once the list is there.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !products) return;
    focused.current = true;
    highlightRef.current?.focus();
  }, [products]);

  // Arrow keys move focus; 1-9 open an active product directly.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;

      if (/^[1-9]$/.test(e.key)) {
        const p = active[Number(e.key) - 1];
        if (p) {
          e.preventDefault();
          choose(p);
        }
        return;
      }

      if (!FOCUS_KEYS.has(e.key)) return;
      const cards = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-product-card]") ?? []);
      if (cards.length === 0) return;
      e.preventDefault();
      const index = cards.indexOf(document.activeElement as HTMLButtonElement);
      if (index === -1) {
        (highlightRef.current ?? cards[0])?.focus();
        return;
      }
      const rects = cards.map((c) => {
        const r = c.getBoundingClientRect();
        return { top: r.top, left: r.left };
      });
      cards[nextFocusIndex(rects, index, e.key as FocusKey)]?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, choose]);

  function markerFor(p: ProductSummary): string | null {
    if (mode === "switch") return p.id === currentProductId ? "Current" : null;
    return highlighted?.id === p.id && rememberedSlug === p.slug ? "Last opened" : null;
  }

  function card(p: ProductSummary, shortcut: number | null) {
    const isHighlighted = highlighted?.id === p.id;
    return (
      <ProductCard
        key={p.id}
        product={p}
        shortcut={shortcut}
        highlighted={isHighlighted}
        marker={markerFor(p)}
        opening={openingId === p.id}
        disabled={openingId !== null}
        onChoose={() => choose(p)}
        cardRef={isHighlighted ? highlightRef : undefined}
      />
    );
  }

  const subtitle =
    products === null
      ? "Loading your products."
      : active.length === 0
        ? "No product on this instance is active."
        : `${active.length} active product${active.length === 1 ? "" : "s"}. Each has its own contacts, flows, topics and team.`;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 px-6 sm:px-8">
        <BrandLockup markSize={26} />
        <div className="flex min-w-0 items-center gap-3">
          <ThemeToggle className="hidden sm:inline-flex" />
          <span className="hidden min-w-0 truncate text-[15px] text-muted-foreground md:inline" title={email}>
            {email}
          </span>
          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            title={signingOut ? "Signing out..." : "Sign out"}
            aria-label="Sign out"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:text-subtle-foreground"
          >
            <LogOut size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 pb-16 pt-8 sm:px-8 sm:pt-16">
        <PageHeader
          eyebrow={mode === "switch" ? "All products" : "Products"}
          title="Choose a product"
          subtitle={subtitle}
          actions={
            instanceAdmin ? (
              <Button
                variant={creating ? "outline" : "default"}
                onClick={() => setCreating((v) => !v)}
                aria-expanded={creating}
              >
                {creating ? "Cancel" : (
                  <>
                    <Plus strokeWidth={1.5} />
                    New product
                  </>
                )}
              </Button>
            ) : undefined
          }
        />

        {creating && (
          <section className="mb-8 rounded-lg border border-border bg-card shadow-card p-6" aria-label="New product">
            <h2 className="text-[16px] font-medium text-foreground">New product</h2>
            <p className="mt-1 text-[14px] text-muted-foreground">
              Its own contacts, flows, topics, transports, brand and keys. You become its owner, and it opens when created.
            </p>
            <div className="mt-4">
              <CreateProductForm autoFocus submitLabel="Create and open" onCreated={(p) => choose(p)} />
            </div>
          </section>
        )}

        {error && (
          <div
            role="alert"
            className="mb-6 flex items-center justify-between gap-4 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5 text-[15px] text-foreground"
          >
            <span>{error}</span>
            {onRetry && (
              <Button size="sm" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        )}

        {!error && (
        <div ref={listRef}>
          {products === null ? (
            <ul className="grid gap-3 sm:grid-cols-2" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="flex items-start gap-4 rounded-lg border border-border p-4">
                  <Skeleton className="h-10 w-10 rounded-md" />
                  <span className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                    <Skeleton className="mt-3 h-6 w-16 rounded-full" />
                  </span>
                </li>
              ))}
            </ul>
          ) : active.length === 0 ? (
            <EmptyState
              compact
              icon={Layers}
              title="No active products"
              description={
                instanceAdmin
                  ? "Create a product to start sending, or open an archived product below to read its data."
                  : "Every product you belong to is archived. Archived products open read-only."
              }
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2" aria-label="Active products">
              {active.map((p, i) => card(p, i < 9 ? i + 1 : null))}
            </ul>
          )}

          {archived.length > 0 && (
            <div className="mt-8">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                aria-expanded={archivedOpen}
                aria-controls="archived-products"
                className="flex items-center gap-1.5 rounded-sm text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <ChevronRight
                  size={14}
                  strokeWidth={1.75}
                  className={cn("transition-transform duration-(--dur-med)", archivedOpen && "rotate-90")}
                />
                Archived
                <span className="font-mono font-normal tracking-normal">{archived.length}</span>
              </button>
              {archivedOpen && (
                <>
                  <p className="mt-2 text-[14px] text-muted-foreground">
                    Archived products accept no events and send nothing. Their data stays readable.
                  </p>
                  <ul id="archived-products" className="mt-3 grid gap-3 sm:grid-cols-2" aria-label="Archived products">
                    {archived.map((p) => card(p, null))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
        )}

        {!error && active.length > 1 && (
          <p className="mt-12 hidden text-[14px] text-muted-foreground sm:block">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to move, <Kbd>Enter</Kbd> to open, <Kbd>1</Kbd>-<Kbd>{Math.min(9, active.length)}</Kbd> to open
            directly. Switch products any time from the sidebar.
          </p>
        )}
      </main>
    </div>
  );
}
