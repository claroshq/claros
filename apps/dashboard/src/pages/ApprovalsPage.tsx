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
 * Critical-class flows (dunning, trial ending) come first.
 *
 * Reviewer actions (G20): edit subject and body (Markdown; the drafted
 * version is kept), revise with AI (an instruction; the worker rewrites the
 * draft and it comes back to the same place, see RevisePanel), and under
 * More: redraft from scratch (optionally forcing an action type) and
 * exclude the person (suppression plus every unsent message cancelled).
 * For approved messages not sent yet: cancel or pull back to review.
 * Keyboard: j/k move, a approve, r reject, e edit, / revise (not while typing).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Inbox, MoreHorizontal } from "lucide-react";
import {
  useMessageQueue,
  useApproveMessage,
  useRejectMessage,
  useBulkApproveMessages,
  useBulkRejectMessages,
  useFailedMessages,
  useRetryMessage,
  useEditMessage,
  useRegenerateMessage,
  useReviseMessage,
  useRevisionWatch,
  DRAFTING_STATUSES,
  useExcludeContact,
  useApprovedMessages,
  useCancelMessage,
  useUnapproveMessage,
  removeFromQueue,
} from "../messages.js";
import { useFlows } from "../flows.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchMessages, type Message, type MessageActionError } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { PageHeader } from "../components/page-header.js";
import { EmptyState } from "../components/empty-state.js";
import { cn } from "../lib/utils.js";
import { RevisePanel } from "../components/revise-panel.js";

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
        "flex items-start gap-3 rounded-md px-3 py-3 transition-colors duration-(--dur-fast)",
        active ? "bg-selected" : "hover:bg-hover",
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
            "block truncate text-[16px] font-medium",
            active ? "text-accent-text" : "text-foreground",
          )}
        >
          {contactLabel(message)}
        </span>
        <span className="mt-0.5 block truncate text-[15px] text-foreground">
          {message.flow?.class === "critical" && (
            <span className="mr-1.5 rounded-sm bg-danger-soft px-1 text-[12px] font-medium text-danger">critical</span>
          )}
          {DRAFTING_STATUSES.has(message.status) && (
            <span className="mr-1.5 rounded-sm bg-accent-soft px-1 text-[12px] font-medium text-accent-text">revising</span>
          )}
          {message.subject ?? "(no subject)"}
        </span>
        <span className="mt-0.5 block truncate text-[14px] text-muted-foreground">
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
  const html = message.preview_html ?? message.body_html;
  if (html) {
    return (
      <iframe
        sandbox=""
        referrerPolicy="no-referrer"
        title="Draft preview"
        srcDoc={html}
        className="h-[420px] w-full rounded-md border border-border bg-[#f9fafb] sm:h-[640px]"
      />
    );
  }
  if (message.body_text) {
    return (
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-4 font-mono text-[14px] text-foreground">
        {message.body_text}
      </pre>
    );
  }
  return (
    <p className="rounded-md border border-border bg-card p-4 text-[16px] text-muted-foreground">
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
    <details className="group mt-10 rounded-lg border border-border bg-card shadow-card">
      <summary className="flex cursor-pointer select-none items-center gap-3 px-6 py-4">
        <span className="text-[17px] font-medium text-foreground">Needs attention</span>
        <Badge variant="danger">{items.length} failed</Badge>
        <span className="flex-1" />
        <span className="text-[15px] text-muted-foreground transition-transform duration-(--dur-fast) group-open:rotate-90">
          &rsaquo;
        </span>
      </summary>
      <div className="border-t border-border px-6 pb-6">
        <p className="mt-4 text-[16px] text-muted-foreground">
          These messages stopped permanently. The reason is recorded on each;
          fix the cause, then retry generation failures.
        </p>
        <ul className="mt-4 divide-y divide-border">
          {items.map((m) => {
            const retryable = m.brain_reasoning?.startsWith("generation_failed:") ?? false;
            return (
              <li key={m.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-[16px] font-medium text-foreground">
                    {flowNames.get(m.flow_id) ?? "Unknown flow"}
                    <span className="ml-2 text-[15px] text-muted-foreground">
                      to {contactLabel(m)}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[16px] text-muted-foreground">
                    {m.brain_reasoning ?? "Send failed permanently after retries."}
                  </p>
                  <p className="mt-0.5 font-mono text-[14px] text-subtle-foreground">
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
          <p className="mt-3 text-[16px] text-danger">
            {retry.error instanceof Error ? retry.error.message : "Retry failed."}
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * Approved messages the drain has not sent yet: a reviewer can cancel one
 * (terminal) or pull it back into the review queue. Collapsed, like the
 * failed list.
 */
function ApprovedSection() {
  const approved = useApprovedMessages();
  const cancel = useCancelMessage();
  const unapprove = useUnapproveMessage();
  const [error, setError] = useState<string | null>(null);
  const items = approved.data?.messages ?? [];
  if (approved.isLoading || items.length === 0) return null;
  const onError = (err: unknown) => {
    const e = err as MessageActionError;
    setError(e?.status === 409 ? `Already ${e.currentStatus ?? "moved on"}; nothing changed.` : (e?.message ?? "Action failed."));
  };
  return (
    <details className="group mt-6 rounded-lg border border-border bg-card shadow-card">
      <summary className="flex cursor-pointer select-none items-center gap-3 px-6 py-4">
        <span className="text-[17px] font-medium text-foreground">Approved, not sent yet</span>
        <Badge variant="neutral">{items.length}</Badge>
        <span className="flex-1" />
        <span className="text-[15px] text-muted-foreground transition-transform duration-(--dur-fast) group-open:rotate-90">
          &rsaquo;
        </span>
      </summary>
      <div className="border-t border-border px-6 pb-6">
        <ul className="mt-2 divide-y divide-border">
          {items.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[16px] font-medium text-foreground">{m.subject ?? "(no subject)"}</p>
                <p className="mt-0.5 truncate text-[15px] text-muted-foreground">
                  to {contactLabel(m)}{m.waiting_reason ? ` · ${m.waiting_reason}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" disabled={unapprove.isPending} onClick={() => { setError(null); unapprove.mutate(m.id, { onError }); }}>
                  Back to review
                </Button>
                <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => { setError(null); cancel.mutate(m.id, { onError }); }}>
                  Cancel send
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {error && <p className="mt-3 text-[16px] text-muted-foreground" role="status">{error}</p>}
      </div>
    </details>
  );
}

/** Inline editor for the draft under review: subject and Markdown body. */
function DraftEditor({ message, onDone }: { message: Message; onDone: (notice: string | null) => void }) {
  const edit = useEditMessage();
  const [subject, setSubject] = useState(message.subject ?? "");
  const [body, setBody] = useState(message.body_text ?? "");
  function save() {
    edit.mutate(
      { id: message.id, subject: subject.trim(), body_markdown: body },
      {
        onSuccess: () => onDone("Draft updated. The drafted version is kept on the message."),
        onError: (err) => {
          const e = err as unknown as MessageActionError;
          onDone(e?.status === 409 ? `That draft is already ${e.currentStatus ?? "handled"}; the edit was not saved.` : `Could not save: ${e?.message ?? "unexpected error"}.`);
        },
      },
    );
  }
  return (
    <div className="mt-5 space-y-3">
      <label className="block text-[15px] font-medium text-muted-foreground">
        Subject
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="mt-1 h-9 w-full rounded-md border border-border bg-card px-3 text-[16px] text-foreground"
        />
      </label>
      <label className="block text-[15px] font-medium text-muted-foreground">
        Body (Markdown)
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          className="mt-1 w-full rounded-md border border-border bg-card p-3 font-mono text-[14px] text-foreground"
        />
      </label>
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={edit.isPending || subject.trim().length === 0 || body.trim().length === 0}>
          {edit.isPending ? "Saving..." : "Save edit"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDone(null)} disabled={edit.isPending}>
          Discard
        </Button>
      </div>
    </div>
  );
}

/**
 * The less frequent actions on a draft, out of the main bar: redraft from
 * scratch (optionally as another action type, the brain then skips its own
 * choice) and exclude the person.
 */
function MoreActions({
  disabled,
  regenerating,
  onRedraft,
  onExclude,
}: {
  disabled: boolean;
  regenerating: boolean;
  onRedraft: (actionType?: string) => void;
  onExclude: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [actionType, setActionType] = useState("");
  const root = useRef<HTMLDivElement | null>(null);
  const validAction = /^[a-z0-9_]{1,64}$/.test(actionType.trim());

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function run(fn: () => void) {
    setOpen(false);
    setActionType("");
    fn();
  }

  const item =
    "flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-[16px] text-foreground transition-colors duration-(--dur-fast) hover:bg-hover disabled:pointer-events-none disabled:text-muted-foreground";

  return (
    <div ref={root} className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal aria-hidden />
        {regenerating ? "Sending back..." : "More"}
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full right-0 z-20 mb-2 w-80 rounded-lg border border-border bg-card shadow-card p-1.5 shadow-lg"
        >
          <button type="button" role="menuitem" className={item} onClick={() => run(() => onRedraft())}>
            <span>
              <span className="block font-medium">Redraft from scratch</span>
              <span className="block text-[15px] text-muted-foreground">Discard this draft and let the AI write a new one.</span>
            </span>
          </button>
          <form
            className="px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (validAction) run(() => onRedraft(actionType.trim()));
            }}
          >
            <label htmlFor="redraft-action" className="block text-[16px] font-medium text-foreground">
              Redraft as another action
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="redraft-action"
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
                placeholder="tip_trick"
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 font-mono text-[14px] text-foreground placeholder:text-subtle-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={!validAction}>
                Redraft
              </Button>
            </div>
            <p className="mt-1 text-[14px] text-subtle-foreground">An action type of the flow, lowercase with underscores.</p>
          </form>
          <div className="my-1 border-t border-border" />
          <button type="button" role="menuitem" className={cn(item, "text-danger")} onClick={() => run(onExclude)}>
            <span>
              <span className="block font-medium">Exclude person</span>
              <span className="block text-[15px] text-muted-foreground">Suppress the address and cancel every unsent message to them.</span>
            </span>
          </button>
        </div>
      )}
    </div>
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
  const regenerate = useRegenerateMessage();
  const revise = useReviseMessage();
  const exclude = useExcludeContact();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const reviseInput = useRef<HTMLTextAreaElement | null>(null);

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
  /** The worker is rewriting the selected draft (revise): no decision until it is back. */
  const drafting = selected !== null && DRAFTING_STATUSES.has(selected.status);
  const actionPending = approve.isPending || reject.isPending || regenerate.isPending || revise.isPending || exclude.isPending || drafting;

  // Follow a revision of the selected draft until the worker is done with it.
  useRevisionWatch(selected, (m) => {
    if (m.status === "pending_approval") {
      setNotice(null);
      return;
    }
    const why = m.status_reason ?? m.brain_reasoning ?? m.status;
    setNotice(`The revision did not come back for review (${m.status}: ${why}).${m.status === "failed" ? " It is listed under failed messages." : ""}`);
  });

  // Leave edit mode when the selection changes.
  useEffect(() => {
    setEditing(false);
  }, [selectedId]);
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

  function handleRevise(instruction: string) {
    if (!selected) return;
    setNotice(null);
    setEditing(false);
    revise.mutate(
      { id: selected.id, instruction },
      { onError: (err) => handleActionError(err, "revise") },
    );
  }

  function handleRegenerate(forcedAction?: string) {
    if (!selected) return;
    setNotice(null);
    const actionType = forcedAction?.trim() || undefined;
    regenerate.mutate(
      { id: selected.id, actionType },
      {
        onSuccess: () => setNotice(actionType ? `Sent back for a new draft as "${actionType}".` : "Sent back for a new draft."),
        onError: (err) => handleActionError(err, "regenerate"),
      },
    );
  }

  function handleExclude() {
    if (!selected) return;
    const who = contactLabel(selected);
    if (!window.confirm(`Exclude ${who} from lifecycle mail? Their address is suppressed and every message not sent yet is cancelled.`)) return;
    setNotice(null);
    exclude.mutate(selected.contact_id, {
      onSuccess: (r) => setNotice(`${who} excluded. ${r.cancelled.length} unsent ${r.cancelled.length === 1 ? "message" : "messages"} cancelled.`),
      onError: (err) => setNotice(`Could not exclude: ${err instanceof Error ? err.message : "unexpected error"}.`),
    });
  }

  // Keyboard: j/k move through the queue, a approve, r reject, e edit.
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || messages.length === 0) return;
      const index = messages.findIndex((m) => m.id === selectedId);
      if (e.key === "j" || e.key === "k") {
        const next = e.key === "j" ? Math.min(index + 1, messages.length - 1) : Math.max(index - 1, 0);
        setSelectedId(messages[next]!.id);
        setNotice(null);
        e.preventDefault();
      } else if (e.key === "a" && !editing && !actionPending) {
        handleApprove();
        e.preventDefault();
      } else if (e.key === "r" && !editing && !actionPending) {
        handleReject();
        e.preventDefault();
      } else if (e.key === "e" && !editing && !actionPending) {
        setEditing(true);
        e.preventDefault();
      } else if (e.key === "/" && !editing) {
        reviseInput.current?.focus();
        e.preventDefault();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, selectedId, editing, actionPending],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

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
  // P5b: drafts held back because the product's daily LLM token budget is spent.
  const waitingForBudget = useQuery({
    queryKey: ["messages", "pending_generation", "llm_budget"],
    queryFn: () => fetchMessages(undefined, "pending_generation"),
    select: (page) => page.messages.filter((m) => m.status_reason === "llm_budget").length,
    refetchInterval: 60_000,
  });

  return (
    <div className="mx-auto max-w-[90rem]">
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

      {(waitingForBudget.data ?? 0) > 0 && (
        <p className="mb-4 rounded-md border border-border bg-muted px-4 py-3 text-[16px] text-foreground" role="status">
          {waitingForBudget.data} {waitingForBudget.data === 1 ? "draft waits" : "drafts wait"} for tomorrow&apos;s LLM budget
          (status reason <code className="font-mono text-[14px]">llm_budget</code>): the product&apos;s daily token budget
          (settings.llm_daily_token_budget) is spent. They are drafted after midnight UTC.
        </p>
      )}

      {queue.isLoading && <QueueSkeleton />}

      {queue.isError && (
        <div
          className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[17px] text-foreground">
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
          <div className="w-full shrink-0 self-start overflow-hidden rounded-lg border border-border bg-card shadow-card lg:w-[22rem]">
            {/* Bulk bar: select-all plus actions for the current selection. */}
            <div className="flex min-h-12 items-center gap-3 border-b border-border px-4 py-2">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={toggleCheckAll}
                aria-label="Select all drafts"
                className="h-4 w-4 shrink-0 cursor-pointer accent-(--accent-deep) disabled:cursor-default"
              />
              {checkedIds.size === 0 ? (
                <span className="text-[15px] text-muted-foreground">
                  Select drafts to act on many at once
                </span>
              ) : (
                <>
                  <span className="text-[15px] font-medium text-foreground">
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

            <div className="space-y-0.5 p-1.5">
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
                className="w-full rounded-none border-t border-border"
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
                  <h2 className="text-[22px] font-semibold leading-[30px] tracking-[-0.015em] text-foreground">
                    {selected.subject ?? "(no subject)"}
                  </h2>
                  <p className="mt-1 text-[16px] text-muted-foreground">
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
                    <span className="font-mono text-[14px]">
                      {formatDate(selected.created_at)}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {selected.flow?.class === "critical" && <Badge variant="danger">critical</Badge>}
                  {selected.brain_action_type && (
                    <span className="rounded-full bg-sunken px-2.5 py-1 font-mono text-[14px] text-muted-foreground">
                      {selected.brain_action_type}
                    </span>
                  )}
                  {selected.edited_at && (
                    <span className="text-[14px] text-muted-foreground">edited</span>
                  )}
                  {drafting ? (
                    <Badge variant="accent" pulse>revising</Badge>
                  ) : (selected.revisions?.length ?? 0) > 0 ? (
                    <span className="text-[14px] text-muted-foreground">
                      revised {selected.revisions!.length}x
                    </span>
                  ) : null}
                </div>
              </div>

              {editing ? (
                <DraftEditor
                  message={selected}
                  onDone={(text) => {
                    setEditing(false);
                    if (text) setNotice(text);
                  }}
                />
              ) : (
                <div className={cn("mt-5 transition-opacity duration-(--dur-fast)", drafting && "opacity-50")} aria-busy={drafting}>
                  <DraftBody message={selected} />
                </div>
              )}

              {selected.original && !editing && (
                <details className="group mt-4 rounded-md border border-border bg-card px-4 py-3">
                  <summary className="cursor-pointer select-none text-[16px] font-medium text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground">
                    As drafted
                  </summary>
                  <p className="mt-2 text-[16px] font-medium text-foreground">{selected.original.subject}</p>
                  <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[14px] text-muted-foreground">
                    {selected.original.body_text}
                  </pre>
                </details>
              )}

              {selected.brain_reasoning && (
                <details className="group mt-4 rounded-md border border-border bg-card px-4 py-3">
                  <summary className="cursor-pointer select-none text-[16px] font-medium text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground">
                    Why the AI wrote it this way
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap text-[16px] leading-relaxed text-muted-foreground">
                    {selected.brain_reasoning}
                  </p>
                </details>
              )}

              {selected.choose && (
                <details open className="group mt-4 rounded-md border border-border bg-card px-4 py-3">
                  <summary className="cursor-pointer select-none text-[16px] font-medium text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground">
                    Why this action (choose step)
                  </summary>
                  <p className="mt-2 text-[16px] text-foreground">
                    Picked <code className="font-mono text-[14px]">{selected.choose.choice}</code>
                    {selected.choose.forced ? " (forced by a reviewer)" : ""}: {selected.choose.reason}
                  </p>
                  {selected.choose.warning && <p className="mt-1 text-[16px] text-foreground">Warning: {selected.choose.warning}</p>}
                  <p className="mt-2 text-[15px] text-muted-foreground">
                    Eligible: {selected.choose.eligible.length > 0 ? selected.choose.eligible.join(", ") : "none"}
                  </p>
                  {selected.choose.filtered_out.length > 0 && (
                    <ul className="mt-1 text-[15px] text-muted-foreground">
                      {selected.choose.filtered_out.map((f) => (
                        <li key={f.action_type}>
                          {f.action_type}: {f.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              )}

              {selected.opening_line && (
                <details className="group mt-4 rounded-md border border-border bg-card px-4 py-3">
                  <summary className="cursor-pointer select-none text-[16px] font-medium text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground">
                    AI opening line
                  </summary>
                  <p className="mt-2 text-[16px] leading-relaxed text-foreground">{selected.opening_line}</p>
                </details>
              )}

              {selected.context_snapshot && (
                <details className="group mt-4 rounded-md border border-border bg-card px-4 py-3">
                  <summary className="cursor-pointer select-none text-[16px] font-medium text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground">
                    Context data used
                  </summary>
                  <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[14px] text-muted-foreground">
                    {JSON.stringify(selected.context_snapshot, null, 2)}
                  </pre>
                </details>
              )}

              {notice && (
                <p
                  className="mt-4 rounded-md border border-border bg-secondary px-3.5 py-2.5 text-[16px] text-foreground"
                  role="status"
                >
                  {notice}
                </p>
              )}

              {!editing && (
                <RevisePanel
                  message={selected}
                  drafting={drafting}
                  disabled={approve.isPending || reject.isPending || regenerate.isPending || exclude.isPending}
                  submitting={revise.isPending}
                  onSubmit={handleRevise}
                  inputRef={reviseInput}
                />
              )}

              <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
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
                <Button variant="ghost" onClick={() => setEditing((v) => !v)} disabled={actionPending}>
                  {editing ? "Close editor" : "Edit"}
                </Button>
                <span className="min-w-0 flex-1 text-[15px] text-muted-foreground">
                  Approval queues it to send. Rejection is final.{" "}
                  <span className="whitespace-nowrap font-mono text-[14px] text-subtle-foreground">j/k a r e /</span>
                </span>
                <MoreActions
                  disabled={actionPending}
                  regenerating={regenerate.isPending}
                  onRedraft={handleRegenerate}
                  onExclude={handleExclude}
                />
              </div>
            </div>
          )}
        </div>
      )}

      <ApprovedSection />

      <FailedSection />

      {totalWaiting > 0 && (
        <p className="mt-8 text-[15px] text-subtle-foreground">
          Flows with approval mode "auto" skip this queue. Approval mode is
          set per flow in the flow editor.
        </p>
      )}
    </div>
  );
}
