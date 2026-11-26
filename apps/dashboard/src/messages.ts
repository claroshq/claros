/**
 * Approval queue hooks.
 *
 * The queue is cursor-paginated, so it is an infinite query: pages append
 * via "Load more", never numbered pages. Approve/reject remove the message
 * from every cached page instead of refetching, so the reviewer's position
 * in the queue is preserved.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  fetchMessages,
  approveMessage,
  rejectMessage,
  bulkApproveMessages,
  bulkRejectMessages,
  fetchFailedMessages,
  retryMessage,
  editMessage,
  regenerateMessage,
  cancelMessage,
  unapproveMessage,
  excludeContact,
  type MessagesPage,
} from "./api.js";
import { HOME_PENDING_QUERY_KEY } from "./home.js";

export const MESSAGES_QUERY_KEY = ["messages"] as const;
export const FAILED_MESSAGES_QUERY_KEY = ["messages", "failed"] as const;
export const APPROVED_MESSAGES_QUERY_KEY = ["messages", "approved"] as const;

/** The pending-approval queue, paginated by cursor. */
export function useMessageQueue() {
  return useInfiniteQuery({
    queryKey: MESSAGES_QUERY_KEY,
    queryFn: ({ pageParam }) => fetchMessages(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
}

/** Remove a message from every cached page (after action or 409 reconcile). */
function removeFromQueue(
  qc: ReturnType<typeof useQueryClient>,
  id: string,
) {
  void qc.invalidateQueries({ queryKey: HOME_PENDING_QUERY_KEY });
  qc.setQueryData<InfiniteData<MessagesPage>>(MESSAGES_QUERY_KEY, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        messages: page.messages.filter((m) => m.id !== id),
      })),
    };
  });
}

export function useApproveMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => approveMessage(id),
    onSuccess: (_data, id) => removeFromQueue(qc, id),
  });
}

export function useRejectMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rejectMessage(id),
    onSuccess: (_data, id) => removeFromQueue(qc, id),
  });
}

/** Remove many messages from every cached page (after a bulk action). */
function removeManyFromQueue(
  qc: ReturnType<typeof useQueryClient>,
  ids: string[],
) {
  void qc.invalidateQueries({ queryKey: HOME_PENDING_QUERY_KEY });
  const idSet = new Set(ids);
  qc.setQueryData<InfiniteData<MessagesPage>>(MESSAGES_QUERY_KEY, (data) => {
    if (!data) return data;
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        messages: page.messages.filter((m) => !idSet.has(m.id)),
      })),
    };
  });
}

export function useBulkApproveMessages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => bulkApproveMessages(ids),
    onSuccess: (result) => removeManyFromQueue(qc, result.acted),
  });
}

export function useBulkRejectMessages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => bulkRejectMessages(ids),
    onSuccess: (result) => removeManyFromQueue(qc, result.acted),
  });
}

/**
 * Messages in the terminal 'failed' state: content generation faults (no
 * LLM configured, bad key, unknown model) and exhausted send retries.
 * Surfaced on the Approvals screen because that is the operator's message
 * queue; a message that never reached the queue is invisible there unless
 * this list exists.
 */
export function useFailedMessages() {
  return useQuery({
    queryKey: FAILED_MESSAGES_QUERY_KEY,
    queryFn: fetchFailedMessages,
    refetchInterval: 30000,
  });
}

/** Re-queue a generation-failed message after the fault is fixed. */
export function useRetryMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => retryMessage(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FAILED_MESSAGES_QUERY_KEY });
    },
  });
}

/** Edit subject/body of the draft under review; the queue is refetched to show the new content. */
export function useEditMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; subject?: string; body_markdown?: string }) =>
      editMessage(input.id, { subject: input.subject, body_markdown: input.body_markdown }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MESSAGES_QUERY_KEY, exact: true });
    },
  });
}

/** Send a draft back for a new one (optionally forcing the action type); it leaves the queue. */
export function useRegenerateMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; actionType?: string }) => regenerateMessage(input.id, input.actionType),
    onSuccess: (_d, input) => removeFromQueue(qc, input.id),
  });
}

/** Exclude the person: suppression plus every unsent message cancelled. */
export function useExcludeContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) => excludeContact(contactId),
    onSuccess: (result) => {
      removeManyFromQueue(qc, result.cancelled);
      void qc.invalidateQueries({ queryKey: APPROVED_MESSAGES_QUERY_KEY });
    },
  });
}

/** Approved messages that have not been sent yet (cancel or pull back to review). */
export function useApprovedMessages() {
  return useQuery({
    queryKey: APPROVED_MESSAGES_QUERY_KEY,
    queryFn: () => fetchMessages(undefined, "approved"),
    refetchInterval: 30000,
  });
}

export function useCancelMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => cancelMessage(id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: APPROVED_MESSAGES_QUERY_KEY });
    },
  });
}

export function useUnapproveMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unapproveMessage(id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: APPROVED_MESSAGES_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: MESSAGES_QUERY_KEY, exact: true });
      void qc.invalidateQueries({ queryKey: HOME_PENDING_QUERY_KEY });
    },
  });
}

export { removeFromQueue };
