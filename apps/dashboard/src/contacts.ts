/**
 * Contacts (People) hooks.
 *
 * The list is cursor-paginated (infinite query). Filters live in the query
 * key, so changing them starts a fresh queue. Detail and timeline are
 * keyed by contact id.
 */
import {
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import {
  fetchContacts,
  fetchContact,
  fetchContactTimeline,
  type ContactFilters,
} from "./api.js";

export const CONTACTS_QUERY_KEY = ["contacts"] as const;

export function contactQueryKey(id: string) {
  return ["contacts", id] as const;
}

export function contactTimelineQueryKey(id: string) {
  return ["contacts", id, "timeline"] as const;
}

/** List contacts with the active filters. */
export function useContacts(filters: ContactFilters) {
  return useInfiniteQuery({
    queryKey: [...CONTACTS_QUERY_KEY, filters],
    queryFn: ({ pageParam }) => fetchContacts(pageParam, filters),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
}

/** One contact with memberships and suppression state. */
export function useContact(id: string) {
  return useQuery({
    queryKey: contactQueryKey(id),
    queryFn: () => fetchContact(id),
  });
}

/** Merged timeline for one contact, cursor-paginated. */
export function useContactTimeline(id: string) {
  return useInfiniteQuery({
    queryKey: contactTimelineQueryKey(id),
    queryFn: ({ pageParam }) => fetchContactTimeline(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
}
