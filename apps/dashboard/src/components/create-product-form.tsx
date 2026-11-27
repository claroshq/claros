/**
 * Create a product (instance admins). Used by Settings, Products and by the
 * product picker. The creator becomes the new product's owner.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createProduct, type Product } from "../api.js";
import { PRODUCTS_QUERY_KEY } from "../products.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

/** "Acme Billing" -> "acme-billing" (the server validates the final value). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function CreateProductForm({
  onCreated,
  autoFocus = false,
  submitLabel = "Create product",
}: {
  onCreated?: (product: Product) => void;
  autoFocus?: boolean;
  submitLabel?: string;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [locale, setLocale] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createProduct({ name: name.trim(), slug, locale: locale.trim() || null }),
    onSuccess: (product) => {
      setName("");
      setSlug("");
      setSlugEdited(false);
      setLocale("");
      setError(null);
      qc.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
      onCreated?.(product);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not create the product."),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
          placeholder="Name"
          aria-label="Product name"
          autoFocus={autoFocus}
          className="max-w-[14rem]"
        />
        <Input
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value);
            setSlugEdited(true);
          }}
          placeholder="slug"
          aria-label="Product slug"
          className="max-w-[12rem] font-mono"
        />
        <Input
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
          placeholder="Locale (optional, e.g. en)"
          aria-label="Locale"
          className="max-w-[13rem]"
        />
        <Button size="sm" type="submit" disabled={!name.trim() || !slug || create.isPending}>
          {create.isPending ? "Creating..." : submitLabel}
        </Button>
      </div>
      {error && <p className="mt-2 text-[15px] text-danger">{error}</p>}
    </form>
  );
}
