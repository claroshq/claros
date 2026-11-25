/**
 * Products query hook (multi-product instances).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchProducts } from "./api.js";

export const PRODUCTS_QUERY_KEY = ["products"] as const;

/** Products the signed-in user can act on, and whether they are an instance admin. */
export function useProducts() {
  return useQuery({ queryKey: PRODUCTS_QUERY_KEY, queryFn: fetchProducts, staleTime: 60_000 });
}
