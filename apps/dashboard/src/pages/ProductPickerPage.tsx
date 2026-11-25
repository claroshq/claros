/**
 * /products: the product picker opened from the sidebar switcher
 * ("All products"). Full screen, outside the shell. Choosing another product
 * switches to it (reload on /home, see product.ts); choosing the open one
 * goes back to the app. `/products?new=1` opens with the "New product"
 * form shown (the switcher's "New product" action).
 */
import { useNavigate, useSearchParams } from "react-router-dom";
import type { MeResponse } from "../api.js";
import { useProducts } from "../products.js";
import { rememberedProductSlug, selectProduct, switchProduct } from "../product.js";
import { ProductPicker } from "../components/product-picker.js";
import { useSignOut } from "../components/use-sign-out.js";

export default function ProductPickerPage({ me }: { me: MeResponse }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const products = useProducts();
  const signOut = useSignOut();

  return (
    <ProductPicker
      mode="switch"
      initialCreating={params.get("new") === "1"}
      products={products.data?.products ?? (products.isError ? [] : null)}
      instanceAdmin={products.data?.instance_admin ?? false}
      currentProductId={me.user.tenantId}
      rememberedSlug={rememberedProductSlug()}
      email={me.user.email}
      error={products.isError ? "Could not load your products." : null}
      onRetry={() => void products.refetch()}
      onChoose={(p) => {
        if (p.id === me.user.tenantId) {
          selectProduct(p.slug, { picked: true });
          navigate("/home");
        } else {
          switchProduct(p.slug);
        }
      }}
      onSignOut={signOut.run}
      signingOut={signOut.pending}
    />
  );
}
