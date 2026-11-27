/**
 * Sent-mail log hooks.
 *
 * TanStack Query hooks for the sent-mail log: the numbered-page list and the
 * single message detail (with event timeline).
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  fetchSentLog,
  fetchSentLogDetail,
  type SentLogFilters,
} from "./api.js";

export const SENT_LOG_QUERY_KEY = ["sent-log"] as const;

/** Page size of the sent-mail log (the API default). */
export const SENT_LOG_PAGE_SIZE = 50;

/**
 * One numbered page of the sent-mail log with filters. The previous page
 * stays on screen while the next one loads, so paging never flashes the
 * skeleton.
 */
export function useSentLog(page: number, filters: SentLogFilters) {
  return useQuery({
    queryKey: [...SENT_LOG_QUERY_KEY, "list", page, filters],
    queryFn: () => fetchSentLog(page, filters),
    placeholderData: keepPreviousData,
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
