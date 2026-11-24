/**
 * Approvals page.
 *
 * The daily-driver inbox: what the AI drafted, waiting for a human. Layout
 * follows the mailbox pattern - a queue column on the left (sender-first:
 * the contact is the primary line, like an inbox sender), the selected
 * draft under review on the right. Rows carry checkboxes for bulk
 * approve/reject; clicking a row previews it.
 *
 * body_html is model-generated content. It is never injected into the
 * dashboard DOM: it renders in an <iframe sandbox=""> (no scripts, no
 * same-origin access, no forms, no popups) via srcdoc. React attribute
 * escaping handles the srcdoc value itself.
 *
 * Approve/reject are CAS on the server, single and bulk. A 409 means the
 * message already moved (another reviewer, a retry, a race): the message is
 * reconciled out of the queue with a quiet notice, not an error banner.
 *
 * Pagination is cursor-based; the queue appends via "Load more".
 */
import React, { useEffect, useMemo, useState } from "react";
import { Inbox } from "lucide-react";
import {
  useMessageQueue,
  useApproveMessage,
  useRejectMessage,
  useBulkApproveMessages,
  useBulkRejectMessages,
  useFailedMessages,
  useRetryMessage,
  removeFromQueue,
} from "../messages.js";
import { useFlows } from "../flows.js";
import { useQueryClient } from "@tanstack/react-query";
import type { Message, MessageActionError } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { PageHeader } from "../components/page-header.js";
import { EmptyState } from "../components/empty-state.js";
import { cn } from "../lib/utils.js";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The inbox "sender" line: name if known, else email, else external id. */
function contactLabel(m: Message): string {
  return m.contact.name ?? m.contact.email ?? m.contact.external_id ?? shortId(m.contact_id);
}

// ---------------------------------------------------------------------------
// Queue item
// ---------------------------------------------------------------------------

interface QueueItemProps {
  message: Message;
  flowName: string | undefined;
  /** The row currently shown in the review pane. */
  active: boolean;
  /** The row is part of the bulk selection. */
  checked: boolean;
  onPreview: () => void;
  onToggleCheck: () => void;
}

function QueueItem({ message, flowName, active, checked, onPreview, onToggleCheck }: QueueItemProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md px-2.5 py-2.5 transition-colors duration-(--dur-fast)",
        active ? "bg-accent-soft" : "hover:bg-secondary",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggleCheck}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select draft for ${contactLabel(message)}`}
        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-(--accent-deep)"
      />
      <button
        type="button"
        onClick={onPreview}
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      >
        <span
          className={cn(
            "block truncate text-[14px] font-medium",
            active ? "text-accent-text" : "text-foreground",
          )}
        >
          {contactLabel(message)}
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-foreground">
          {message.subject ?? "(no subject)"}
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
          {flowName ?? "Unknown flow"}
          {message.flow_step_order !== null && ` · step ${message.flow_step_order}`}
          {" · "}
          <span className="font-mono">{formatDate(message.created_at)}</span>
        </span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Draft preview (isolated)
// ---------------------------------------------------------------------------

function DraftBody({ message }: { message: Message }) {
  if (message.body_html) {
    return (
      <iframe
        sandbox=""
        referrerPolicy="no-referrer"
        title="Draft preview"
        srcDoc={message.body_html}
        className="h-[300px] w-full rounded-md border border-border bg-white sm:h-[420px]"
      />
    );
  }
  if (message.body_text) {
    return (
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-4 font-mono text-[13px] text-foreground">
        {message.body_text}
      </pre>
    );
  }
  return (
    <p className="rounded-md border border-border bg-card p-4 text-[14px] text-muted-foreground">
      This draft has no body content.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Page states
// ---------------------------------------------------------------------------

function QueueSkeleton() {
  return (
    <div className="flex gap-6">
      <div className="w-80 shrink-0 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
      <div className="min-w-0 flex-1 space-y-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

/**
 * Terminal failures, shown because a message that never reaches the queue
 * is otherwise invisible: generation faults (no LLM configured, bad key,
 * unknown model) and exhausted send retries land in 'failed'. The reason
 * recorded by the worker is shown verbatim. Generation failures can be
 * re-queued once the fault is fixed.
 *
 * Rendered as a collapsed disclosure below the inbox: it is a recovery
 * list, not the day's work, so it must never dominate the screen.
 */
function FailedSection() {
  const failed = useFailedMessages();
  const retry = useRetryMessage();
  const flowsQuery = useFlows();

  const flowNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of flowsQuery.data?.flows ?? []) {
      map.set(f.id, f.name);
    }
    return map;
  }, [flowsQuery.data]);

  const items = failed.data?.messages ?? [];
  if (failed.isLoading || items.length === 0) {
    return null;
  }

  return (
    <details className="group mt-10 rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer select-none items-center gap-3 px-6 py-4">
        <span className="text-[15px] font-medium text-foreground">Needs attention</span>
        <Badge variant="danger">{items.length} failed</Badge>
        <span className="flex-1" />
        <span className="text-[13px] text-muted-foreground transition-transform duration-(--dur-fast) group-open:rotate-90">
          &rsaquo;
        </span>
      </summary>
      <div className="border-t border-border px-6 pb-6">
        <p className="mt-4 text-[14px] text-muted-foreground">
          These messages stopped permanently. The reason is recorded on each;
          fix the cause, then retry generation failures.
        </p>
        <ul className="mt-4 divide-y divide-border">
          {items.map((m) => {
            const retryable = m.brain_reasoning?.startsWith("generation_failed:") ?? false;
            return (
              <li key={m.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-foreground">
                    {flowNames.get(m.flow_id) ?? "Unknown flow"}
                    <span className="ml-2 text-[13px] text-muted-foreground">
                      to {contactLabel(m)}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[14px] text-muted-foreground">
                    {m.brain_reasoning ?? "Send failed permanently after retries."}
                  </p>
                  <p className="mt-0.5 font-mono text-[13px] text-subtle-foreground">
                    {formatDate(m.updated_at)}
                  </p>
                </div>
                {retryable && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => retry.mutate(m.id)}
                    disabled={retry.isPending}
                  >
                    Retry generation
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {retry.isError && (
          <p className="mt-3 text-[14px] text-danger">
            {retry.error instanceof Error ? retry.error.message : "Retry failed."}
          </p>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ApprovalsPage() {
  const queue = useMessageQueue();
  const flowsQuery = useFlows();
  const approve = useApproveMessage();
  const reject = useRejectMessage();
  const bulkApprove = useBulkApproveMessages();
  const bulkReject = useBulkRejectMessages();
  const qc = useQueryClient();

  const messages = useMemo(
    () => queue.data?.pages.flatMap((p) => p.messages) ?? [],
    [queue.data],
  );

  const flowNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of flowsQuery.data?.flows ?? []) {
      map.set(f.id, f.name);
    }
    return map;
  }, [flowsQuery.data]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  // Keep the preview selection and the bulk selection valid as the queue
  // changes (action, 409, refetch).
  useEffect(() => {
    if (messages.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      if (checkedIds.size > 0) setCheckedIds(new Set());
      return;
    }
    if (!selectedId || !messages.some((m) => m.id === selectedId)) {
      setSelectedId(messages[0]!.id);
    }
    setCheckedIds((prev) => {
      const next = new Set([...prev].filter((id) => messages.some((m) => m.id === id)));
      return next.size === prev.size ? prev : next;
    });
  }, [messages, selectedId, checkedIds.size]);

  const selected = messages.find((m) => m.id === selectedId) ?? null;
  const actionPending = approve.isPending || reject.isPending;
  const bulkPending = bulkApprove.isPending || bulkReject.isPending;

  function handleActionError(err: unknown, verb: string) {
    const e = err as MessageActionError;
    if (e && e.status === 409 && selected) {
      // Someone or something else already handled this message. Reconcile:
      // drop it from the queue, say why, move on.
      removeFromQueue(qc, selected.id);
      setNotice(
        `That draft was already ${e.currentStatus ?? "handled"} elsewhere. It has been removed from your queue.`,
      );
      return;
    }
    setNotice(
      `Could not ${verb} the draft: ${e?.message ?? "unexpected error"}. It is still in your queue.`,
    );
  }

  function handleApprove() {
    if (!selected) return;
    setNotice(null);
    approve.mutate(selected.id, {
      onError: (err) => handleActionError(err, "approve"),
    });
  }

  function handleReject() {
    if (!selected) return;
    setNotice(null);
    reject.mutate(selected.id, {
      onError: (err) => handleActionError(err, "reject"),
    });
  }

  function toggleCheck(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allChecked = messages.length > 0 && checkedIds.size === messages.length;

  function toggleCheckAll() {
    setCheckedIds(allChecked ? new Set() : new Set(messages.map((m) => m.id)));
  }

  function handleBulk(verb: "approve" | "reject") {
    const ids = [...checkedIds];
    if (ids.length === 0) return;
    setNotice(null);
    const mutation = verb === "approve" ? bulkApprove : bulkReject;
    mutation.mutate(ids, {
      onSuccess: (result) => {
        setCheckedIds(new Set());
        if (result.skipped.length > 0) {
          setNotice(
            `${result.acted.length} ${verb === "approve" ? "approved" : "rejected"}. ${result.skipped.length} could not be moved (already handled elsewhere) and stayed in the queue.`,
          );
        }
      },
      onError: (err) => {
        setNotice(
          `Bulk ${verb} failed: ${err instanceof Error ? err.message : "unexpected error"}. Nothing was changed.`,
        );
      },
    });
  }

  const totalWaiting = messages.length;
  const hasMore = queue.hasNextPage;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Review"
        title="Approvals"
        subtitle={
          queue.isLoading
            ? "Loading the review queue."
            : totalWaiting === 0
              ? "Nothing is waiting for review."
              : `${totalWaiting}${hasMore ? "+" : ""} ${totalWaiting === 1 ? "draft" : "drafts"} waiting for review`
        }
      />

      {queue.isLoading && <QueueSkeleton />}

      {queue.isError && (
        <div
          className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[15px] text-foreground">
            Failed to load the queue:{" "}
            {queue.error instanceof Error ? queue.error.message : "Unknown error"}
          </p>
          <Button variant="outline" size="sm" onClick={() => queue.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {!queue.isLoading && !queue.isError && totalWaiting === 0 && (
        <EmptyState
          icon={Inbox}
          title="Nothing is waiting for review"
          description="When a flow with approval mode &quot;require&quot; produces a draft, it lands here: the queue on the left, the email preview on the right."
        />
      )}

      {!queue.isLoading && !queue.isError && totalWaiting > 0 && (
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* Queue column */}
          <div className="w-full shrink-0 lg:w-80">
            {/* Bulk bar: select-all plus actions for the current selection. */}
            <div className="mb-2 flex items-center gap-2.5 rounded-md border border-border bg-card px-2.5 py-2">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={toggleCheckAll}
                aria-label="Select all drafts"
                className="h-4 w-4 shrink-0 cursor-pointer accent-(--accent-deep) disabled:cursor-default"
              />
              {checkedIds.size === 0 ? (
                <span className="text-[13px] text-muted-foreground">
                  Select drafts to act on many at once
                </span>
              ) : (
                <>
                  <span className="text-[13px] font-medium text-foreground">
                    {checkedIds.size} selected
                  </span>
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    onClick={() => handleBulk("approve")}
                    disabled={bulkPending}
                  >
                    {bulkApprove.isPending ? "Approving..." : "Approve all"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleBulk("reject")}
                    disabled={bulkPending}
                  >
                    {bulkReject.isPending ? "Rejecting..." : "Reject all"}
                  </Button>
                </>
              )}
            </div>

            <div className="space-y-0.5">
              {messages.map((m) => (
                <QueueItem
                  key={m.id}
                  message={m}
                  flowName={flowNames.get(m.flow_id)}
                  active={m.id === selectedId}
                  checked={checkedIds.has(m.id)}
                  onPreview={() => {
                    setSelectedId(m.id);
                    setNotice(null);
                  }}
                  onToggleCheck={() => toggleCheck(m.id)}
                />
              ))}
            </div>
            {hasMore && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 w-full"
                disabled={queue.isFetchingNextPage}
                onClick={() => queue.fetchNextPage()}
              >
                {queue.isFetchingNextPage ? "Loading..." : "Load more"}
              </Button>
            )}
          </div>

          {/* Review pane */}
          {selected && (
          <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">
                    {selected.subject ?? "(no subject)"}
                  </h2>
                  <p className="mt-1 text-[14px] text-muted-foreground">
                    {"to "}
                    <span className="text-foreground">{contactLabel(selected)}</span>
                    {selected.contact.email && selected.contact.name && (
                      <> ({selected.contact.email})</>
                    )}
                    {" · "}
                    {flowNames.get(selected.flow_id) ?? "Unknown flow"}
                    {selected.flow_step_order !== null &&
                      ` · step ${selected.flow_step_order}`}
                    {" · "}
                    <span className="font-mono text-[13px]">
                      {formatDate(selected.created_at)}
                    </span>
                  </p>
                </div>
                {selected.brain_action_type && (
                  <span className="shrink-0 rounded-full bg-sunken px-2.5 py-1 font-mono text-[12px] text-muted-foreground">
                    {selected.brain_action_type}
                  </span>
                )}
              </div>

              <div className="mt-5">
                <DraftBody message={selected} />
              </div>

              {selected.brain_reasoning && (
                <details className="group mt-4 rounded-md border border-border bg-card px-4 py-3">
                  <summary className="cursor-pointer select-none text-[14px] font-medium text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground">
                    Why the AI wrote it this way
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-muted-foreground">
                    {selected.brain_reasoning}
                  </p>
                </details>
              )}

              {notice && (
                <p
                  className="mt-4 rounded-md border border-border bg-secondary px-3.5 py-2.5 text-[14px] text-foreground"
                  role="status"
                >
                  {notice}
                </p>
              )}

              <div className="mt-6 flex items-center gap-3 border-t border-border pt-5">
                <Button onClick={handleApprove} disabled={actionPending}>
                  {approve.isPending ? "Approving..." : "Approve"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleReject}
                  disabled={actionPending}
                >
                  {reject.isPending ? "Rejecting..." : "Reject"}
                </Button>
                <span className="text-[13px] text-muted-foreground">
                  Approval queues it to send. Rejection is final.
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      <FailedSection />

      {totalWaiting > 0 && (
        <p className="mt-8 text-[13px] text-subtle-foreground">
          Flows with approval mode "auto" skip this queue. Approval mode is
          set per flow in the flow editor.
        </p>
      )}
    </div>
  );
}
