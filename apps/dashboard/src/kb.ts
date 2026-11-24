/**
 * Knowledge base hooks.
 *
 * The list is cursor-paginated (infinite query, "Load more"). Detail is a
 * plain query by id. Mutations invalidate both.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  fetchKbEntries,
  fetchKbEntry,
  createKbEntry,
  updateKbEntry,
  deleteKbEntry,
  reembedKb,
  type KbEntryInput,
} from "./api.js";

export const KB_QUERY_KEY = ["kb"] as const;

export function kbEntryQueryKey(id: string) {
  return ["kb", id] as const;
}

/** List entries (previews). includeInactive toggles the inactive filter. */
export function useKbEntries(includeInactive: boolean) {
  return useInfiniteQuery({
    queryKey: [...KB_QUERY_KEY, { includeInactive }],
    queryFn: ({ pageParam }) => fetchKbEntries(pageParam, includeInactive),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
}

/** Fetch one full entry. */
export function useKbEntry(id: string) {
  return useQuery({
    queryKey: kbEntryQueryKey(id),
    queryFn: () => fetchKbEntry(id),
  });
}

function useInvalidateKb() {
  const qc = useQueryClient();
  return (id?: string) => {
    void qc.invalidateQueries({ queryKey: KB_QUERY_KEY });
    if (id) void qc.invalidateQueries({ queryKey: kbEntryQueryKey(id) });
  };
}

export function useCreateKbEntry() {
  const invalidate = useInvalidateKb();
  return useMutation({
    mutationFn: (input: KbEntryInput) => createKbEntry(input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateKbEntry(id: string) {
  const invalidate = useInvalidateKb();
  return useMutation({
    mutationFn: (input: Partial<KbEntryInput>) => updateKbEntry(id, input),
    onSuccess: () => invalidate(id),
  });
}

export function useDeleteKbEntry(id: string) {
  const invalidate = useInvalidateKb();
  return useMutation({
    mutationFn: () => deleteKbEntry(id),
    onSuccess: () => invalidate(),
  });
}

/**
 * Re-embed failed/orphaned entries. Returns counts, not a job: { enqueued,
 * remaining, total_qualifying }. remaining > 0 means another call enqueues
 * the next batch; that is the only progress signal the API offers.
 */
export function useReembedKb() {
  const invalidate = useInvalidateKb();
  return useMutation({
    mutationFn: () => reembedKb(),
    onSuccess: () => invalidate(),
  });
}
