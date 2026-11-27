/**
 * Product entry decision and picker helpers (multi-product instances).
 */
import { describe, it, expect } from "vitest";
import type { ProductSummary } from "../src/api.js";
import {
  decideEntry,
  highlightedProduct,
  nextFocusIndex,
  productMonogram,
  productHue,
  PRODUCT_HUES,
  switcherProducts,
  type EntryInput,
} from "../src/product-entry.js";

function product(slug: string, opts: { archived?: boolean; role?: string } = {}): ProductSummary {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    role: opts.role ?? "owner",
    archived: opts.archived ?? false,
    public_host: null,
    logo_url: null,
  };
}

function input(overrides: Partial<EntryInput>): EntryInput {
  return {
    products: [],
    instanceAdmin: false,
    currentProductId: "id-default",
    productInUrl: false,
    pickedThisSession: false,
    ...overrides,
  };
}

describe("decideEntry", () => {
  it("opens the only active product directly", () => {
    const d = decideEntry(input({ products: [product("default")] }));
    expect(d).toEqual({ kind: "shell" });
  });

  it("switches to the only active product when the current (home) product is archived", () => {
    const products = [product("default", { archived: true }), product("acme")];
    const d = decideEntry(input({ products, currentProductId: "id-default", instanceAdmin: true }));
    expect(d).toEqual({ kind: "switch", product: products[1] });
  });

  it("switches when the current product is not listed at all", () => {
    const d = decideEntry(input({ products: [product("acme")], currentProductId: "id-gone" }));
    expect(d.kind).toBe("switch");
  });

  it("shows the picker for two or more active products, ignoring archived ones in the count", () => {
    expect(decideEntry(input({ products: [product("a"), product("b")] }))).toEqual({ kind: "picker" });
    expect(
      decideEntry(input({ products: [product("a"), product("b", { archived: true }), product("c")] })),
    ).toEqual({ kind: "picker" });
  });

  it("does not show the picker for one active product plus archived ones", () => {
    const products = [product("a", { archived: true }), product("b", { archived: true }), product("default")];
    expect(decideEntry(input({ products }))).toEqual({ kind: "shell" });
  });

  it("does not show the picker again once a product was chosen in this tab", () => {
    const d = decideEntry(input({ products: [product("a"), product("b")], pickedThisSession: true }));
    expect(d).toEqual({ kind: "shell" });
  });

  it("respects a product named in the URL", () => {
    const products = [product("default", { archived: true }), product("acme")];
    expect(decideEntry(input({ products, productInUrl: true }))).toEqual({ kind: "shell" });
    expect(decideEntry(input({ products: [product("a"), product("b")], productInUrl: true }))).toEqual({ kind: "shell" });
  });

  it("with no active product: picker for instance admins, the shell for everyone else", () => {
    const products = [product("default", { archived: true })];
    expect(decideEntry(input({ products, instanceAdmin: true }))).toEqual({ kind: "picker" });
    expect(decideEntry(input({ products, instanceAdmin: false }))).toEqual({ kind: "shell" });
    expect(decideEntry(input({ products: [], instanceAdmin: true }))).toEqual({ kind: "picker" });
    expect(decideEntry(input({ products: [] }))).toEqual({ kind: "shell" });
  });
});

describe("highlightedProduct", () => {
  const products = [product("a"), product("b"), product("old", { archived: true })];

  it("prefers the remembered product", () => {
    expect(highlightedProduct(products, "b", "id-a")?.slug).toBe("b");
  });

  it("falls back to the current product, then the first active one", () => {
    expect(highlightedProduct(products, "gone", "id-b")?.slug).toBe("b");
    expect(highlightedProduct(products, null, "id-zzz")?.slug).toBe("a");
  });

  it("never highlights an archived product while an active one exists", () => {
    expect(highlightedProduct(products, "old", "id-old")?.slug).toBe("a");
  });

  it("highlights an archived product when nothing is active", () => {
    const all = [product("x", { archived: true }), product("y", { archived: true })];
    expect(highlightedProduct(all, "y", "id-x")?.slug).toBe("y");
    expect(highlightedProduct([], null, "id-x")).toBeNull();
  });
});

describe("productMonogram", () => {
  it("takes initials of two words, or the first two letters of one", () => {
    expect(productMonogram("Acme Billing")).toBe("AB");
    expect(productMonogram("acme")).toBe("AC");
    expect(productMonogram("my-product")).toBe("MP");
    expect(productMonogram("  ")).toBe("?");
  });
});

describe("nextFocusIndex", () => {
  // Two-column grid: 0 1 / 2 3 / 4
  const grid = [
    { top: 0, left: 0 },
    { top: 0, left: 300 },
    { top: 100, left: 0 },
    { top: 100, left: 300 },
    { top: 200, left: 0 },
  ];

  it("moves left and right in reading order and stops at the edges", () => {
    expect(nextFocusIndex(grid, 1, "ArrowRight")).toBe(2);
    expect(nextFocusIndex(grid, 1, "ArrowLeft")).toBe(0);
    expect(nextFocusIndex(grid, 0, "ArrowLeft")).toBe(0);
    expect(nextFocusIndex(grid, 4, "ArrowRight")).toBe(4);
  });

  it("moves up and down by row, keeping the column", () => {
    expect(nextFocusIndex(grid, 1, "ArrowDown")).toBe(3);
    expect(nextFocusIndex(grid, 3, "ArrowUp")).toBe(1);
    expect(nextFocusIndex(grid, 3, "ArrowDown")).toBe(4);
    expect(nextFocusIndex(grid, 0, "ArrowUp")).toBe(0);
  });

  it("works in a single column and supports Home and End", () => {
    const column = [{ top: 0, left: 0 }, { top: 90, left: 0 }, { top: 180, left: 0 }];
    expect(nextFocusIndex(column, 0, "ArrowDown")).toBe(1);
    expect(nextFocusIndex(column, 2, "ArrowUp")).toBe(1);
    expect(nextFocusIndex(column, 1, "Home")).toBe(0);
    expect(nextFocusIndex(column, 0, "End")).toBe(2);
    expect(nextFocusIndex([], 0, "End")).toBe(-1);
  });
});

describe("switcherProducts", () => {
  const products = [
    { ...product("acme-billing"), name: "Acme Billing", public_host: "mail.acme.test" },
    product("old", { archived: true }),
    { ...product("zeta"), name: "Zeta" },
  ];

  it("never lists archived products", () => {
    expect(switcherProducts(products, "").map((p) => p.slug)).toEqual(["acme-billing", "zeta"]);
    expect(switcherProducts(products, "old")).toEqual([]);
  });

  it("filters by name, slug or public host, case-insensitively", () => {
    expect(switcherProducts(products, "BILL").map((p) => p.slug)).toEqual(["acme-billing"]);
    expect(switcherProducts(products, "mail.acme").map((p) => p.slug)).toEqual(["acme-billing"]);
    expect(switcherProducts(products, " zet ").map((p) => p.slug)).toEqual(["zeta"]);
  });
});

describe("productHue", () => {
  it("is stable per id and always a listed hue", () => {
    expect(productHue("abc")).toBe(productHue("abc"));
    for (const id of ["a", "b", "tenant-1", "0f8e2c", ""]) {
      expect(PRODUCT_HUES).toContain(productHue(id));
    }
  });

  it("spreads ids across hues", () => {
    const hues = new Set(Array.from({ length: 50 }, (_, i) => productHue(`id-${i}`)));
    expect(hues.size).toBeGreaterThan(3);
  });
});
