/**
 * Email template hooks (Templates page and studio). The list carries
 * rendered previews; mutations invalidate it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLayout,
  deleteLayout,
  fetchLayout,
  fetchLayouts,
  updateLayout,
  setActiveLayout,
  type LayoutWidth,
} from "./api.js";
import { TENANT_QUERY_KEY } from "./settings.js";

export const LAYOUTS_QUERY_KEY = ["layouts"] as const;

export function useLayouts() {
  return useQuery({ queryKey: [...LAYOUTS_QUERY_KEY, "list"], queryFn: () => fetchLayouts(true) });
}

export function useLayout(ref: string) {
  return useQuery({ queryKey: [...LAYOUTS_QUERY_KEY, "one", ref], queryFn: () => fetchLayout(ref), staleTime: Infinity });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: LAYOUTS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: TENANT_QUERY_KEY });
  };
}

export function useSaveLayout() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { id: string | null; name: string; width: LayoutWidth; source: string; basedOn: string | null }) =>
      input.id
        ? updateLayout(input.id, { name: input.name, width: input.width, source: input.source })
        : createLayout({ name: input.name, width: input.width, source: input.source, based_on: input.basedOn }),
    onSuccess: invalidate,
  });
}

export function useUseLayout() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (ref: string) => setActiveLayout(ref), onSuccess: invalidate });
}

export function useDeleteLayout() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: string) => deleteLayout(id), onSuccess: invalidate });
}
