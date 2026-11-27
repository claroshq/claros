/**
 * Instance keys (instance admins), shown on Settings, Products.
 *
 * An instance key (clr_ik_) automates the instance: products
 * (products:write), a product's admin keys (keys:write) and transports
 * (transports:write), instance reads (instance:read) and erasing a person
 * in every product (people:erase). The raw key is shown once.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createInstanceKey, fetchInstanceKeys, revokeInstanceKey } from "../../api.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Section, formatDate } from "./shared.js";

const QUERY_KEY = ["instance-keys"];

const SCOPE_HELP: Record<string, string> = {
  "products:write": "create, update, archive products",
  "keys:write": "manage a product's admin keys",
  "transports:write": "manage a product's transports and routing",
  "instance:read": "read instance settings, health, products",
  "people:erase": "erase a person in every product",
};

export default function InstanceKeysSettings() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: QUERY_KEY, queryFn: fetchInstanceKeys });
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createInstanceKey({ label: label.trim() || undefined, scopes }),
    onSuccess: (k) => {
      setRaw(k.key);
      setLabel("");
      setScopes([]);
      setError(null);
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not create the key."),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeInstanceKey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const all = keys.data?.scopes ?? Object.keys(SCOPE_HELP);
  const list = keys.data?.keys ?? [];

  return (
    <Section
      title="Instance keys"
      configured={null}
      description="Keys for automating this install from scripts and CI: Authorization: Bearer clr_ik_... Product-level routes take the product from the X-Claros-Product header."
    >
      {keys.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <>
          {list.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-[16px]">
                <thead>
                  <tr className="bg-sunken text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    <th className="px-4 py-2">Key</th>
                    <th className="px-4 py-2">Scopes</th>
                    <th className="px-4 py-2">Last used</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((k) => (
                    <tr key={k.id}>
                      <td className="px-4 py-2.5">
                        <p className="text-foreground">{k.label ?? "Unnamed key"}</p>
                        <p className="font-mono text-[14px] text-muted-foreground">{k.prefix}...</p>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {k.scopes.map((s) => (
                            <Badge key={s} variant="neutral">{s}</Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-[15px] text-muted-foreground">
                        {k.last_used_at ? formatDate(k.last_used_at) : "never"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {k.revoked_at ? (
                          <Badge variant="warning">revoked</Badge>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={revoke.isPending}
                            onClick={() => {
                              if (confirm(`Revoke ${k.label ?? k.prefix}? Requests with it stop working at once.`)) revoke.mutate(k.id);
                            }}
                          >
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {raw && (
            <div className="mt-4 rounded-md border border-border bg-sunken p-3">
              <p className="text-[15px] text-foreground">Copy this key now. It is not shown again.</p>
              <p className="mt-1 break-all font-mono text-[14px] text-foreground">{raw}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => setRaw(null)}>
                Done
              </Button>
            </div>
          )}

          <form
            className="mt-6"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <h3 className="text-[16px] font-medium text-foreground">Create an instance key</h3>
            <div className="mt-3 flex flex-col gap-2">
              {all.map((s) => (
                <label key={s} className="flex items-center gap-2 text-[16px] text-foreground">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))}
                  />
                  <span className="font-mono text-[14px]">{s}</span>
                  <span className="text-[15px] text-muted-foreground">{SCOPE_HELP[s] ?? ""}</span>
                </label>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label (e.g. CI deploy)"
                aria-label="Key label"
                className="max-w-[16rem]"
              />
              <Button size="sm" type="submit" disabled={scopes.length === 0 || create.isPending}>
                {create.isPending ? "Creating..." : "Create key"}
              </Button>
            </div>
            {error && <p className="mt-2 text-[15px] text-danger">{error}</p>}
          </form>
        </>
      )}
    </Section>
  );
}
