/**
 * Sign out from the shell or the product picker: end the session, forget
 * the per-tab product choice (the next sign-in shows the picker again) and
 * hard reload on /login so no state survives.
 */
import { useLogout } from "../auth.js";
import { forgetPickedProduct } from "../product.js";

export function useSignOut(): { run: () => void; pending: boolean } {
  const logout = useLogout();
  return {
    run: () =>
      logout.mutate(undefined, {
        onSuccess: () => {
          forgetPickedProduct();
          window.location.href = "/login";
        },
      }),
    pending: logout.isPending,
  };
}
