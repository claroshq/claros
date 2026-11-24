/**
 * Sent-mail log hooks.
 *
 * TanStack Query hooks for the sent-mail log: the paginated list and the
 * single message detail (with event timeline).
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  fetchSentLog,
  fetchSentLogDetail,
  type SentLogFilters,
} from "./api.js";

export const SENT_LOG_QUERY_KEY = ["sent-log"] as const;

/** Paginated sent-mail log list with filters. */
export function useSentLog(filters: SentLogFilters) {
  return useInfiniteQuery({
    queryKey: [...SENT_LOG_QUERY_KEY, filters],
    queryFn: ({ pageParam }) => fetchSentLog(pageParam, filters),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
}

/** Single message detail with event timeline. */
export function useSentLogDetail(id: string) {
  return useQuery({
    queryKey: [...SENT_LOG_QUERY_KEY, id],
    queryFn: () => fetchSentLogDetail(id),
    enabled: !!id,
  });
}
