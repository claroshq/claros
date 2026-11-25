/**
 * Product entry gate (multi-product instances).
 *
 * Sits between the auth gate and the shell. On app open it reads the
 * product list once and decides (product-entry.ts): open the shell as is,
 * switch to the only active product first, or show the full-screen product
 * picker. The decision is taken once per page load; later product list
 * refetches do not move the user.
 *
 * Switching happens before the shell renders, so nothing product-scoped is
 * cached yet: storing the selection and refetching /auth/me is enough, no
 * page reload. If the product list cannot be loaded the shell opens as
 * before (the picker is a convenience, never a lock).
 */
import React, { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { MeResponse } from "../api.js";
import { useMe } from "../auth.js";
import { useProducts } from "../products.js";
import { ME_QUERY_KEY } from "../query-client.js";
import {
  pickedThisSession,
  productInUrl,
  rememberedProductSlug,
  selectProduct,
} from "../product.js";
import { decideEntry } from "../product-entry.js";
import { ProductPicker, type PickerTarget } from "./product-picker.js";
import { useSignOut } from "./use-sign-out.js";

type Phase =
  | { kind: "deciding" }
  | { kind: "picker" }
  | { kind: "switching"; targetId: string }
  | { kind: "shell" };

export function ProductGate({ me, children }: { me: MeResponse; children: React.ReactNode }) {
  const qc = useQueryClient();
  const meQuery = useMe();
  const products = useProducts();
  const signOut = useSignOut();
  const [phase, setPhase] = useState<Phase>({ kind: "deciding" });
  // Read once: the picker highlights the product chosen before this load.
  const [remembered] = useState(rememberedProductSlug);

  const switchTo = useCallback(
    (target: PickerTarget, picked: boolean) => {
      selectProduct(target.slug, { picked });
      if (target.id === me.user.tenantId) {
        setPhase({ kind: "shell" });
        return;
      }
      setPhase({ kind: "switching", targetId: target.id });
      void qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
    [me.user.tenantId, qc],
  );

  useEffect(() => {
    if (phase.kind !== "deciding") return;
    if (products.isError) {
      setPhase({ kind: "shell" });
      return;
    }
    if (!products.data) return;
    const decision = decideEntry({
      products: products.data.products,
      instanceAdmin: products.data.instance_admin,
      currentProductId: me.user.tenantId,
      productInUrl: productInUrl(),
      pickedThisSession: pickedThisSession(),
    });
    if (decision.kind === "switch") switchTo(decision.product, false);
    else setPhase({ kind: decision.kind });
  }, [phase.kind, products.data, products.isError, me.user.tenantId, switchTo]);

  // The switch is done once /auth/me reports the new product. A refused
  // switch (the refetch fails) falls back to the shell; apiFetch then drops
  // the refused selection on the first 401.
  useEffect(() => {
    if (phase.kind !== "switching") return;
    if (me.user.tenantId === phase.targetId || meQuery.isError) setPhase({ kind: "shell" });
  }, [phase, me.user.tenantId, meQuery.isError]);

  if (phase.kind === "shell") return <>{children}</>;
  if (phase.kind !== "picker") return null;

  return (
    <ProductPicker
      mode="entry"
      products={products.data?.products ?? null}
      instanceAdmin={products.data?.instance_admin ?? false}
      currentProductId={me.user.tenantId}
      rememberedSlug={remembered}
      email={me.user.email}
      onChoose={(p) => switchTo(p, true)}
      onSignOut={signOut.run}
      signingOut={signOut.pending}
    />
  );
}
