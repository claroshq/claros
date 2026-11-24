/**
 * Suppressions hooks.
 *
 * TanStack Query hooks for the suppressions list and CSV import.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchSuppressions, importSuppressions, addSuppression } from "./api.js";

export const SUPPRESSIONS_QUERY_KEY = ["suppressions"] as const;

/** Paginated suppressions list. */
export function useSuppressions() {
  return useInfiniteQuery({
    queryKey: SUPPRESSIONS_QUERY_KEY,
    queryFn: ({ pageParam }) => fetchSuppressions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
}

/** Import suppressions from CSV text. */
export function useImportSuppressions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => importSuppressions(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SUPPRESSIONS_QUERY_KEY });
    },
  });
}

/** Manually suppress a single address. */
export function useAddSuppression() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => addSuppression(email),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SUPPRESSIONS_QUERY_KEY });
    },
  });
}
