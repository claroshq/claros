/**
 * Contacts (People) hooks.
 *
 * The list is cursor-paginated (infinite query). Filters live in the query
 * key, so changing them starts a fresh queue. Detail and timeline are
 * keyed by contact id.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  fetchContacts,
  fetchContact,
  fetchContactTimeline,
  fetchContactNotes,
  addContactNote,
  deleteContactNote,
  deleteContact,
  type ContactFilters,
  setContactTopics,
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

export function contactNotesQueryKey(id: string) {
  return ["contacts", id, "notes"] as const;
}

/** The team's notes about one person, newest first. */
export function useContactNotes(id: string) {
  return useQuery({
    queryKey: contactNotesQueryKey(id),
    queryFn: () => fetchContactNotes(id),
  });
}

export function useAddContactNote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => addContactNote(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactNotesQueryKey(id) }),
  });
}

export function useDeleteContactNote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) => deleteContactNote(id, noteId),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactNotesQueryKey(id) }),
  });
}

/** Set one or more topic subscriptions of the person (source "admin"). */
export function useSetContactTopics(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (topics: Record<string, boolean>) => setContactTopics(id, topics),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactQueryKey(id) }),
  });
}

/** Erase the person; the People list refetches. */
export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteContact(id),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: contactQueryKey(id) });
      void qc.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
    },
  });
}
