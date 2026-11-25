/**
 * Settings / Products (instance admins).
 *
 * Every product of this install: create one, archive or unarchive it, or
 * switch to it. An archived product keeps its data readable; changes to it
 * are refused until it is unarchived.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMe } from "../../auth.js";
import { createProduct, setProductArchived } from "../../api.js";
import { PRODUCTS_QUERY_KEY, useProducts } from "../../products.js";
import { switchProduct } from "../../product.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section } from "./shared.js";

/** "Acme Billing" -> "acme-billing" (the server validates the final value). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export default function ProductsSettings() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const products = useProducts();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [locale, setLocale] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createProduct({ name: name.trim(), slug, locale: locale.trim() || null }),
    onSuccess: () => {
      setName("");
      setSlug("");
      setSlugEdited(false);
      setLocale("");
      setError(null);
      qc.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not create the product."),
  });

  const archive = useMutation({
    mutationFn: ({ slug: s, archived }: { slug: string; archived: boolean }) => setProductArchived(s, archived),
    onSuccess: () => qc.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY }),
  });

  if (products.data && !products.data.instance_admin) {
    return (
      <Section title="Products" configured={null}>
        <p className="text-[14px] text-muted-foreground">Only instance admins manage products.</p>
      </Section>
    );
  }

  const list = products.data?.products ?? [];

  return (
    <Section
      title="Products"
      configured={null}
      description="Each product has its own contacts, flows, settings and team. Archived products stay readable and refuse changes."
    >
      {products.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="bg-sunken text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  <th className="px-4 py-2">Product</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-2.5">
                      <p className="text-foreground">
                        {p.name}
                        {p.id === me?.user.tenantId && (
                          <span className="ml-2 text-[12px] text-muted-foreground">(current)</span>
                        )}
                      </p>
                      <p className="font-mono text-[12px] text-muted-foreground">{p.slug}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={p.archived ? "warning" : "neutral"}>{p.archived ? "archived" : "active"}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {p.id !== me?.user.tenantId && (
                          <Button size="sm" variant="outline" onClick={() => switchProduct(p.slug)}>
                            Open
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={archive.isPending}
                          onClick={() => {
                            if (p.archived || confirm(`Archive ${p.name}? Its data stays readable; changes are refused until you unarchive it.`)) {
                              archive.mutate({ slug: p.slug, archived: !p.archived });
                            }
                          }}
                        >
                          {p.archived ? "Unarchive" : "Archive"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form
            className="mt-6"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <h3 className="text-[14px] font-medium text-foreground">Create a product</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              You become its owner. Invite its team from Settings, Team after switching to it.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugEdited) setSlug(slugify(e.target.value));
                }}
                placeholder="Name"
                aria-label="Product name"
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
                {create.isPending ? "Creating..." : "Create product"}
              </Button>
            </div>
            {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
          </form>
        </>
      )}
    </Section>
  );
}
