/**
 * Approvals page.
 *
 * The daily-driver inbox: what the AI drafted, waiting for a human. One
 * workspace surface, sized to the viewport at lg+, in the mailbox pattern:
 * the queue on the left (sender-first, like an inbox), the draft under
 * review on the right. The two panes scroll on their own, so the queue and
 * the decision bar never leave the screen.
 *
 * The review pane reads top to bottom in decision order: a toolbar with
 * every action (Approve, Reject, Edit, Revise, More) and its key, the
 * subject and recipient, then the email preview beside a context rail with
 * what the reviewer needs to judge it (why the AI wrote it, the choose
 * step, details, the drafted version, context data).
 *
 * Three views share the header, kept in ?view=: the review queue, approved
 * messages not sent yet, and what needs attention (failed and held).
 *
 * body_html is model-generated content. It is never injected into the
 * dashboard DOM: it renders in an <iframe sandbox=""> (no scripts, no
 * same-origin access, no forms, no popups) via srcdoc. React attribute
 * escaping handles the srcdoc value itself.
 *
 * Approve and reject take effect after a short undo window: the draft
 * leaves the queue at once, the next draft opens, and the call goes to the
 * server when the window closes (or at once when the page unmounts or
 * closes). An undone decision never reaches the server. Both are CAS on the
 * server: a 409 means the message already moved (another reviewer, a
 * retry), and it is reconciled out of the queue with a quiet notice.
 *
 * Pagination is cursor-based; the queue appends via "Load more".
 * Critical-class flows (dunning, trial ending) come first.
 *
 * Keyboard: j/k move, a approve, r reject, e edit, / revise, z undo
 * (not while typing).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  PenLine,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import {
  useMessageQueue,
  useApproveMessage,
  useRejectMessage,
  useBulkApproveMessages,
  useBulkRejectMessages,
  useFailedMessages,
  useRetryMessage,
  useHeldMessages,
  useReleaseMessage,
  useDismissMessage,
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
  MESSAGES_QUERY_KEY,
} from "../messages.js";
import { useFlows } from "../flows.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approveMessage,
  fetchMessages,
  rejectMessage,
  type Message,
  type MessageActionError,
} from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { cn } from "../lib/utils.js";
import { RevisePanel } from "../components/revise-panel.js";
import { nextSelection, parseView, sharedFlowId, type ApprovalsView } from "../approvals-model.js";

/** How long an approve or reject can be undone before it is sent to the server. */
const UNDO_MS = 5000;

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

function actionErrorText(err: unknown): string {
  const e = err as MessageActionError;
  return e?.status === 409 ? `Already ${e.currentStatus ?? "moved on"}; nothing changed.` : (e?.message ?? "Action failed.");
}

/** A key hint inside a button or a line of help text. */
function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-current/25 px-1 font-mono text-micro leading-none opacity-70", className)}>
      {children}
    </kbd>
  );
}

/** A caption heading for a group inside a pane. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-caption font-semibold uppercase tracking-[0.07em] text-subtle-foreground">{children}</h3>
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

interface ToastState {
  key: number;
  text: string;
  tone?: "error";
  undo?: () => void;
}

/**
 * One notice at a time, at the bottom of the content column. It replaces
 * the inline notices that used to push the decision bar down. An undo
 * toast lives as long as the undo window; errors stay longer.
 */
function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const counter = useRef(0);
  const show = useCallback((t: Omit<ToastState, "key">) => {
    counter.current += 1;
    setToast({ ...t, key: counter.current });
  }, []);
  const clear = useCallback(() => setToast(null), []);
  useEffect(() => {
    if (!toast) return;
    const ms = toast.undo ? UNDO_MS : toast.tone === "error" ? 12000 : 6000;
    const t = window.setTimeout(() => setToast((cur) => (cur?.key === toast.key ? null : cur)), ms);
    return () => window.clearTimeout(t);
  }, [toast]);
  return { toast, show, clear };
}

function Toast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
  return (
    <div
      className="pointer-events-none fixed inset-x-4 bottom-6 z-40 flex justify-center lg:left-[calc(248px+1rem)]"
      role="status"
      aria-live="polite"
    >
      {toast && (
        <div
          key={toast.key}
          className={cn(
            "pointer-events-auto flex max-w-xl items-center gap-4 rounded-lg border bg-card py-2.5 pl-4 pr-2 text-body text-foreground shadow-overlay",
            toast.tone === "error" ? "border-danger" : "border-border",
          )}
        >
          <span className="min-w-0 flex-1">{toast.text}</span>
          {toast.undo && (
            <Button size="sm" variant="outline" onClick={toast.undo}>
              Undo <Kbd>Z</Kbd>
            </Button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Dismiss"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queue item
// ---------------------------------------------------------------------------

interface QueueItemProps {
  message: Message;
  /** Null when the queue header already names the one flow of every row. */
  flowName: string | null;
  /** The row currently shown in the review pane. */
  active: boolean;
  /** The row is part of the bulk selection. */
  checked: boolean;
  /** A bulk selection is in progress: every checkbox stays visible. */
  selecting: boolean;
  onPreview: () => void;
  onToggleCheck: () => void;
}

function QueueItem({ message, flowName, active, checked, selecting, onPreview, onToggleCheck }: QueueItemProps) {
  const rowRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <li
      ref={rowRef}
      className={cn(
        "group flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors duration-(--dur-fast)",
        active ? "bg-selected" : "hover:bg-hover",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggleCheck}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select draft for ${contactLabel(message)}`}
        className={cn(
          "mt-1 h-4 w-4 shrink-0 cursor-pointer accent-(--accent-deep) opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
          (selecting || checked) && "opacity-100",
        )}
      />
      <button
        type="button"
        onClick={onPreview}
        aria-current={active ? "true" : undefined}
        className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-baseline gap-3">
          <span className={cn("min-w-0 flex-1 truncate text-body font-medium", active ? "text-accent-text" : "text-foreground")}>
            {contactLabel(message)}
          </span>
          <span className="shrink-0 font-mono text-caption text-subtle-foreground">{formatDate(message.created_at)}</span>
        </span>
        <span className="mt-0.5 block truncate text-small text-muted-foreground">
          {message.flow?.class === "critical" && (
            <span className="mr-1.5 rounded-sm bg-danger-soft px-1 text-micro font-medium text-danger">critical</span>
          )}
          {DRAFTING_STATUSES.has(message.status) && (
            <span className="mr-1.5 rounded-sm bg-accent-soft px-1 text-micro font-medium text-accent-text">revising</span>
          )}
          {message.subject ?? "(no subject)"}
        </span>
        {flowName !== null && (
          <span className="mt-0.5 block truncate text-caption text-subtle-foreground">
            {flowName}
            {message.flow_step_order !== null && ` · step ${message.flow_step_order}`}
          </span>
        )}
      </button>
    </li>
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
        className="h-[32rem] w-full shrink-0 rounded-md border border-border bg-[#f9fafb] @3xl:h-auto @3xl:min-h-[24rem] @3xl:flex-1"
      />
    );
  }
  if (message.body_text) {
    return (
      <pre className="flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-4 font-mono text-small text-foreground">
        {message.body_text}
      </pre>
    );
  }
  return (
    <p className="rounded-md border border-border bg-card p-4 text-body text-muted-foreground">
      This draft has no body content.
    </p>
  );
}

/** Inline editor for the draft under review: subject and Markdown body. */
function DraftEditor({ message, onDone }: { message: Message; onDone: (notice: string | null, error?: boolean) => void }) {
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
          onDone(
            e?.status === 409
              ? `That draft is already ${e.currentStatus ?? "handled"}; the edit was not saved.`
              : `Could not save: ${e?.message ?? "unexpected error"}.`,
            true,
          );
        },
      },
    );
  }
  return (
    <div className="flex flex-1 flex-col gap-3">
      <label className="block text-small font-medium text-muted-foreground">
        Subject
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-body text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <label className="flex flex-1 flex-col text-small font-medium text-muted-foreground">
        Body (Markdown)
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          className="mt-1 min-h-[16rem] w-full flex-1 resize-none rounded-md border border-input bg-card p-3 font-mono text-small text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
    "flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-body text-foreground transition-colors duration-(--dur-fast) hover:bg-hover disabled:pointer-events-none disabled:text-muted-foreground";

  return (
    <div ref={root} className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={regenerating ? "Sending back" : "More actions"}
      >
        <MoreHorizontal aria-hidden />
        {regenerating && "Sending back..."}
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-2 w-80 rounded-lg border border-border bg-card p-1.5 shadow-overlay">
          <button type="button" role="menuitem" className={item} onClick={() => run(() => onRedraft())}>
            <span>
              <span className="block font-medium">Redraft from scratch</span>
              <span className="block text-small text-muted-foreground">Discard this draft and let the AI write a new one.</span>
            </span>
          </button>
          <form
            className="px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (validAction) run(() => onRedraft(actionType.trim()));
            }}
          >
            <label htmlFor="redraft-action" className="block text-body font-medium text-foreground">
              Redraft as another action
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="redraft-action"
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
                placeholder="tip_trick"
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 font-mono text-small text-foreground placeholder:text-subtle-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={!validAction}>
                Redraft
              </Button>
            </div>
            <p className="mt-1 text-caption text-subtle-foreground">An action type of the flow, lowercase with underscores.</p>
          </form>
          <div className="my-1 border-t border-border" />
          <button type="button" role="menuitem" className={cn(item, "text-danger")} onClick={() => run(onExclude)}>
            <span>
              <span className="block font-medium">Exclude person</span>
              <span className="block text-small text-muted-foreground">Suppress the address and cancel every unsent message to them.</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context rail
// ---------------------------------------------------------------------------

function RailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-5 py-4">
      <SectionLabel>{title}</SectionLabel>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function RailDisclosure({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group px-5 py-4">
      <summary className="flex cursor-pointer select-none items-center gap-2 text-caption font-semibold uppercase tracking-[0.07em] text-subtle-foreground transition-colors duration-(--dur-fast) hover:text-foreground">
        <span className="flex-1">{title}</span>
        <ChevronDown className="size-4 transition-transform duration-(--dur-fast) group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

/** What the reviewer needs to judge the draft, beside the preview. */
function ContextRail({ message, flowName }: { message: Message; flowName: string | undefined }) {
  const revisions = message.revisions?.length ?? 0;
  return (
    <div className="divide-y divide-border">
      {message.brain_reasoning && (
        <RailSection title="Why the AI wrote it">
          <p className="whitespace-pre-wrap text-small leading-relaxed text-foreground">{message.brain_reasoning}</p>
        </RailSection>
      )}

      {message.choose && (
        <RailSection title="Why this action">
          <p className="text-small leading-relaxed text-foreground">
            Picked <code className="font-mono text-small">{message.choose.choice}</code>
            {message.choose.forced ? " (forced by a reviewer)" : ""}: {message.choose.reason}
          </p>
          {message.choose.warning && <p className="mt-1 text-small text-foreground">Warning: {message.choose.warning}</p>}
          <p className="mt-2 text-small text-muted-foreground">
            Eligible: {message.choose.eligible.length > 0 ? message.choose.eligible.join(", ") : "none"}
          </p>
          {message.choose.filtered_out.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-small text-muted-foreground">
              {message.choose.filtered_out.map((f) => (
                <li key={f.action_type}>
                  {f.action_type}: {f.reason}
                </li>
              ))}
            </ul>
          )}
        </RailSection>
      )}

      {message.opening_line && (
        <RailSection title="AI opening line">
          <p className="text-small leading-relaxed text-foreground">{message.opening_line}</p>
        </RailSection>
      )}

      <RailSection title="Details">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-small">
          <dt className="text-muted-foreground">To</dt>
          <dd className="min-w-0 truncate text-foreground">{contactLabel(message)}</dd>
          {message.contact.email && message.contact.name && (
            <>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="min-w-0 truncate text-foreground">{message.contact.email}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Flow</dt>
          <dd className="min-w-0 truncate">
            <Link to={`/flows/${message.flow_id}/edit`} className="text-accent-text underline-offset-4 hover:underline">
              {flowName ?? "Unknown flow"}
            </Link>
            {message.flow_step_order !== null && <span className="text-muted-foreground"> · step {message.flow_step_order}</span>}
          </dd>
          {message.brain_action_type && (
            <>
              <dt className="text-muted-foreground">Action</dt>
              <dd className="min-w-0 truncate font-mono text-foreground">{message.brain_action_type}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Drafted</dt>
          <dd className="font-mono text-foreground">{formatDate(message.created_at)}</dd>
          {message.edited_at && (
            <>
              <dt className="text-muted-foreground">Edited</dt>
              <dd className="font-mono text-foreground">{formatDate(message.edited_at)}</dd>
            </>
          )}
          {revisions > 0 && (
            <>
              <dt className="text-muted-foreground">Revised</dt>
              <dd className="text-foreground">{revisions}x</dd>
            </>
          )}
        </dl>
      </RailSection>

      {message.original && (
        <RailDisclosure title="As drafted">
          <p className="text-small font-medium text-foreground">{message.original.subject}</p>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-small text-muted-foreground">
            {message.original.body_text}
          </pre>
        </RailDisclosure>
      )}

      {message.context_snapshot && (
        <RailDisclosure title="Context data used">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-small text-muted-foreground">
            {JSON.stringify(message.context_snapshot, null, 2)}
          </pre>
        </RailDisclosure>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review view
// ---------------------------------------------------------------------------

function WorkspaceSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <div className="w-[20rem] shrink-0 space-y-2 border-r border-border p-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
      <div className="min-w-0 flex-1 space-y-4 p-5">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

/** The review queue when nothing waits: what feeds it and where else to look. */
function ReviewEmpty({ approvedCount, attentionCount }: { approvedCount: number; attentionCount: number }) {
  const flowsQuery = useFlows();
  const requireFlows = (flowsQuery.data?.flows ?? []).filter((f) => f.approval_mode === "require" && f.status !== "archived");
  const shown = requireFlows.slice(0, 6);
  return (
    <div className="rounded-lg border border-border bg-card shadow-card">
      <div className="flex flex-col gap-10 px-6 py-10 sm:px-10 lg:flex-row lg:gap-16 lg:py-12">
        <div className="max-w-md">
          <span className="flex size-11 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
            <CheckCheck size={20} strokeWidth={1.5} aria-hidden />
          </span>
          <h2 className="mt-5 font-display text-headline font-bold tracking-[-0.02em] text-foreground">All caught up</h2>
          <p className="mt-2 text-body leading-relaxed text-muted-foreground">
            Drafts from flows that require approval wait here until someone approves, edits or rejects them.
            New drafts appear as soon as the AI writes them.
          </p>
          <p className="mt-6 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-small text-subtle-foreground">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> move, <Kbd>A</Kbd> approve, <Kbd>R</Kbd> reject, <Kbd>E</Kbd> edit, <Kbd>/</Kbd> revise
          </p>
        </div>

        <div className="min-w-0 flex-1 lg:max-w-md">
          <SectionLabel>Flows that require approval</SectionLabel>
          {flowsQuery.isLoading ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-5 w-44" />
            </div>
          ) : requireFlows.length === 0 ? (
            <p className="mt-3 text-body leading-relaxed text-muted-foreground">
              None. Every flow sends without review. Set a flow&apos;s approval mode to &quot;require&quot; in the flow editor
              to review its drafts here.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {shown.map((f) => (
                <li key={f.id}>
                  <Link
                    to={`/flows/${f.id}/edit`}
                    className="group flex items-center gap-3 py-2.5 text-body text-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate group-hover:text-accent-text">{f.name}</span>
                    <Badge variant={f.status === "active" ? "success" : "neutral"}>{f.status}</Badge>
                  </Link>
                </li>
              ))}
              {requireFlows.length > shown.length && (
                <li className="py-2.5 text-small text-muted-foreground">
                  and {requireFlows.length - shown.length} more in <Link to="/flows" className="text-accent-text hover:underline">Flows</Link>
                </li>
              )}
            </ul>
          )}

          {(approvedCount > 0 || attentionCount > 0) && (
            <div className="mt-6 flex flex-col gap-2">
              {approvedCount > 0 && (
                <Link to="?view=approved" className="inline-flex items-center gap-1.5 text-body text-accent-text hover:underline">
                  {approvedCount} approved, waiting to send <ArrowRight className="size-4" aria-hidden />
                </Link>
              )}
              {attentionCount > 0 && (
                <Link to="?view=attention" className="inline-flex items-center gap-1.5 text-body text-accent-text hover:underline">
                  {attentionCount} {attentionCount === 1 ? "message needs" : "messages need"} attention <ArrowRight className="size-4" aria-hidden />
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface PendingDecision {
  verb: "approve" | "reject";
  timer: number;
}

function ReviewView({ approvedCount, attentionCount }: { approvedCount: number; attentionCount: number }) {
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
  const { toast, show: showToast, clear: clearToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);
  const reviseInput = useRef<HTMLTextAreaElement | null>(null);

  /** Drafts decided but still inside the undo window: hidden from the queue. */
  const pending = useRef(new Map<string, PendingDecision>());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  /** The most recent decision, for z. */
  const lastDecided = useRef<string | null>(null);

  const allMessages = useMemo(() => queue.data?.pages.flatMap((p) => p.messages) ?? [], [queue.data]);
  const messages = useMemo(() => allMessages.filter((m) => !hidden.has(m.id)), [allMessages, hidden]);

  const flowNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of flowsQuery.data?.flows ?? []) map.set(f.id, f.name);
    return map;
  }, [flowsQuery.data]);
  const oneFlow = useMemo(() => sharedFlowId(messages.map((m) => m.flow_id)), [messages]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  // Keep the preview selection and the bulk selection valid as the queue
  // changes (decision, 409, refetch).
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
  const selectedIndex = selected ? messages.indexOf(selected) : -1;
  /** The worker is rewriting the selected draft (revise): no decision until it is back. */
  const drafting = selected !== null && DRAFTING_STATUSES.has(selected.status);
  const actionPending = regenerate.isPending || revise.isPending || exclude.isPending || drafting;
  const showRevise = reviseOpen || drafting;

  // Follow a revision of the selected draft until the worker is done with it.
  useRevisionWatch(selected, (m) => {
    if (m.status === "pending_approval") return;
    const why = m.status_reason ?? m.brain_reasoning ?? m.status;
    showToast({
      text: `The revision did not come back for review (${m.status}: ${why}).${m.status === "failed" ? " It is listed under Needs attention." : ""}`,
      tone: "error",
    });
  });

  // A new draft under review starts with the editor and the composer closed.
  useEffect(() => {
    setEditing(false);
    setReviseOpen(false);
  }, [selectedId]);

  useEffect(() => {
    if (reviseOpen) reviseInput.current?.focus();
  }, [reviseOpen]);

  const unhide = useCallback((id: string) => {
    setHidden((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  /** Send a decision to the server once its undo window closes. */
  const commit = useCallback(
    (id: string) => {
      const p = pending.current.get(id);
      if (!p) return;
      window.clearTimeout(p.timer);
      pending.current.delete(id);
      if (lastDecided.current === id) lastDecided.current = null;
      const mutation = p.verb === "approve" ? approve : reject;
      // mutateAsync: several decisions can be in flight, each needs its own outcome.
      mutation.mutateAsync(id).then(
        () => unhide(id),
        (err: unknown) => {
          const e = err as MessageActionError;
          if (e?.status === 409) {
            removeFromQueue(qc, id);
            unhide(id);
            showToast({ text: `That draft was already ${e.currentStatus ?? "handled"} elsewhere. It has been removed from your queue.` });
            return;
          }
          unhide(id);
          showToast({ text: `Could not ${p.verb} the draft: ${e?.message ?? "unexpected error"}. It is back in your queue.`, tone: "error" });
        },
      );
    },
    [approve, reject, qc, unhide, showToast],
  );

  // Leaving the page (route change or tab close) sends what is still waiting.
  useEffect(() => {
    const flush = () => {
      for (const [id, p] of pending.current) {
        window.clearTimeout(p.timer);
        void (p.verb === "approve" ? approveMessage(id) : rejectMessage(id)).catch(() => undefined);
      }
      pending.current.clear();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      const hadPending = pending.current.size > 0;
      flush();
      if (hadPending) void qc.invalidateQueries({ queryKey: MESSAGES_QUERY_KEY });
    };
  }, [qc]);

  function undo(id: string) {
    const p = pending.current.get(id);
    if (!p) return;
    window.clearTimeout(p.timer);
    pending.current.delete(id);
    if (lastDecided.current === id) lastDecided.current = null;
    unhide(id);
    setSelectedId(id);
    clearToast();
  }

  function decide(verb: "approve" | "reject") {
    if (!selected || actionPending) return;
    const id = selected.id;
    const who = contactLabel(selected);
    setSelectedId(nextSelection(messages.map((m) => m.id), id));
    setHidden((prev) => new Set(prev).add(id));
    const timer = window.setTimeout(() => commit(id), UNDO_MS);
    pending.current.set(id, { verb, timer });
    lastDecided.current = id;
    showToast({
      text: verb === "approve" ? `Approved the draft to ${who}. It goes out through the send path.` : `Rejected the draft to ${who}.`,
      undo: () => undo(id),
    });
  }

  function handleRevise(instruction: string) {
    if (!selected) return;
    setEditing(false);
    revise.mutate(
      { id: selected.id, instruction },
      { onError: (err) => showToast({ text: `Could not revise the draft: ${actionErrorText(err)}`, tone: "error" }) },
    );
  }

  function handleRegenerate(forcedAction?: string) {
    if (!selected) return;
    const actionType = forcedAction?.trim() || undefined;
    regenerate.mutate(
      { id: selected.id, actionType },
      {
        onSuccess: () => showToast({ text: actionType ? `Sent back for a new draft as "${actionType}".` : "Sent back for a new draft." }),
        onError: (err) => showToast({ text: `Could not redraft: ${actionErrorText(err)}`, tone: "error" }),
      },
    );
  }

  function handleExclude() {
    if (!selected) return;
    const who = contactLabel(selected);
    if (!window.confirm(`Exclude ${who} from lifecycle mail? Their address is suppressed and every message not sent yet is cancelled.`)) return;
    exclude.mutate(selected.contact_id, {
      onSuccess: (r) =>
        showToast({ text: `${who} excluded. ${r.cancelled.length} unsent ${r.cancelled.length === 1 ? "message" : "messages"} cancelled.` }),
      onError: (err) => showToast({ text: `Could not exclude: ${err instanceof Error ? err.message : "unexpected error"}.`, tone: "error" }),
    });
  }

  function move(delta: 1 | -1) {
    if (messages.length === 0) return;
    const index = Math.max(0, selectedIndex);
    const next = Math.min(Math.max(index + delta, 0), messages.length - 1);
    setSelectedId(messages[next]!.id);
  }

  // Keyboard: j/k move, a approve, r reject, e edit, / revise, z undo.
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A held key repeats: j/k may scroll the queue, but a held a, r or z
      // must not decide (or undo) one draft after another.
      if (e.repeat && e.key !== "j" && e.key !== "k") return;
      if (e.key === "z" && lastDecided.current) {
        undo(lastDecided.current);
        e.preventDefault();
        return;
      }
      if (messages.length === 0) return;
      if (e.key === "j" || e.key === "k") {
        move(e.key === "j" ? 1 : -1);
        e.preventDefault();
      } else if (e.key === "a" && !editing && !actionPending) {
        decide("approve");
        e.preventDefault();
      } else if (e.key === "r" && !editing && !actionPending) {
        decide("reject");
        e.preventDefault();
      } else if (e.key === "e" && !editing && !actionPending) {
        setEditing(true);
        e.preventDefault();
      } else if (e.key === "/" && !editing) {
        setReviseOpen(true);
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
  const bulkPending = bulkApprove.isPending || bulkReject.isPending;

  function toggleCheckAll() {
    setCheckedIds(allChecked ? new Set() : new Set(messages.map((m) => m.id)));
  }

  function handleBulk(verb: "approve" | "reject") {
    const ids = [...checkedIds];
    if (ids.length === 0) return;
    if (verb === "reject" && !window.confirm(`Reject ${ids.length} ${ids.length === 1 ? "draft" : "drafts"}? Rejection is final.`)) return;
    const mutation = verb === "approve" ? bulkApprove : bulkReject;
    mutation.mutate(ids, {
      onSuccess: (result) => {
        setCheckedIds(new Set());
        const done = `${result.acted.length} ${verb === "approve" ? "approved" : "rejected"}.`;
        showToast({
          text:
            result.skipped.length > 0
              ? `${done} ${result.skipped.length} could not be moved (already handled elsewhere) and stayed in the queue.`
              : done,
        });
      },
      onError: (err) =>
        showToast({ text: `Bulk ${verb} failed: ${err instanceof Error ? err.message : "unexpected error"}. Nothing was changed.`, tone: "error" }),
    });
  }

  const totalWaiting = messages.length;
  const hasMore = queue.hasNextPage;

  let body: React.ReactNode;
  if (queue.isLoading) {
    body = <WorkspaceSkeleton />;
  } else if (queue.isError) {
    body = (
      <div className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3" role="alert">
        <p className="text-body text-foreground">
          Failed to load the queue: {queue.error instanceof Error ? queue.error.message : "Unknown error"}
        </p>
        <Button variant="outline" size="sm" onClick={() => queue.refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (totalWaiting === 0) {
    body = <ReviewEmpty approvedCount={approvedCount} attentionCount={attentionCount} />;
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-card lg:min-h-[34rem] lg:flex-row">
        {/* Queue */}
        <section aria-label="Review queue" className="flex max-h-80 shrink-0 flex-col border-b border-border lg:max-h-none lg:w-[20rem] lg:border-b-0 lg:border-r">
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={toggleCheckAll}
              aria-label="Select all drafts"
              className="h-4 w-4 shrink-0 cursor-pointer accent-(--accent-deep)"
            />
            {checkedIds.size === 0 ? (
              <span className="min-w-0 flex-1 truncate text-small text-muted-foreground">
                <span className="font-medium text-foreground">
                  {totalWaiting}
                  {hasMore ? "+" : ""} {totalWaiting === 1 ? "draft" : "drafts"}
                </span>
                {oneFlow && ` · ${flowNames.get(oneFlow) ?? "Unknown flow"}`}
              </span>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-small font-medium text-foreground">{checkedIds.size} selected</span>
                <Button size="sm" onClick={() => handleBulk("approve")} disabled={bulkPending}>
                  {bulkApprove.isPending ? "Approving..." : "Approve"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleBulk("reject")} disabled={bulkPending}>
                  {bulkReject.isPending ? "Rejecting..." : "Reject"}
                </Button>
              </>
            )}
          </div>

          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1.5">
            {messages.map((m) => (
              <QueueItem
                key={m.id}
                message={m}
                flowName={oneFlow ? null : (flowNames.get(m.flow_id) ?? "Unknown flow")}
                active={m.id === selectedId}
                checked={checkedIds.has(m.id)}
                selecting={checkedIds.size > 0}
                onPreview={() => setSelectedId(m.id)}
                onToggleCheck={() => toggleCheck(m.id)}
              />
            ))}
            {hasMore && (
              <li>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1 w-full"
                  disabled={queue.isFetchingNextPage}
                  onClick={() => queue.fetchNextPage()}
                >
                  {queue.isFetchingNextPage ? "Loading..." : "Load more"}
                </Button>
              </li>
            )}
          </ul>
        </section>

        {/* Review pane */}
        {selected && (
          <section aria-label="Draft under review" className="@container flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border px-5 pb-4 pt-3">
              {/* Toolbar: position, then every action with its key. */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="mr-auto flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="size-8" data-repeatable onClick={() => move(-1)} disabled={selectedIndex <= 0} aria-label="Previous draft (K)">
                    <ChevronUp aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    data-repeatable
                    onClick={() => move(1)}
                    disabled={selectedIndex >= messages.length - 1}
                    aria-label="Next draft (J)"
                  >
                    <ChevronDown aria-hidden />
                  </Button>
                  <span className="ml-1 font-mono text-caption text-subtle-foreground">
                    {selectedIndex + 1} / {totalWaiting}
                    {hasMore ? "+" : ""}
                  </span>
                </div>
                <Button size="sm" onClick={() => decide("approve")} disabled={actionPending || editing}>
                  <Check aria-hidden />
                  Approve <Kbd className="hidden @3xl:inline-flex">A</Kbd>
                </Button>
                <Button size="sm" variant="outline" onClick={() => decide("reject")} disabled={actionPending || editing}>
                  Reject <Kbd className="hidden @3xl:inline-flex">R</Kbd>
                </Button>
                <Button
                  size="sm"
                  variant={editing ? "secondary" : "outline"}
                  onClick={() => setEditing((v) => !v)}
                  disabled={actionPending}
                  aria-pressed={editing}
                >
                  <PenLine aria-hidden />
                  <span className="sr-only @2xl:not-sr-only">{editing ? "Close editor" : "Edit"}</span>
                  {!editing && <Kbd className="hidden @3xl:inline-flex">E</Kbd>}
                </Button>
                <Button
                  size="sm"
                  variant={showRevise ? "secondary" : "outline"}
                  onClick={() => setReviseOpen((v) => !v)}
                  disabled={editing || drafting}
                  aria-pressed={showRevise}
                >
                  <Sparkles aria-hidden />
                  <span className="sr-only @2xl:not-sr-only">Revise</span>
                  <Kbd className="hidden @3xl:inline-flex">/</Kbd>
                </Button>
                <MoreActions disabled={actionPending} regenerating={regenerate.isPending} onRedraft={handleRegenerate} onExclude={handleExclude} />
              </div>

              <div className="mt-4 flex items-start gap-3">
                <h2 className="min-w-0 flex-1 text-heading font-semibold tracking-[-0.015em] text-foreground">
                  {selected.subject ?? "(no subject)"}
                </h2>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 pt-0.5">
                  {selected.flow?.class === "critical" && <Badge variant="danger">critical</Badge>}
                  {drafting && <Badge variant="accent" pulse>revising</Badge>}
                  {selected.edited_at && <Badge variant="neutral">edited</Badge>}
                </div>
              </div>
              <p className="mt-1 truncate text-body text-muted-foreground">
                {"to "}
                <span className="text-foreground">{contactLabel(selected)}</span>
                {selected.contact.email && selected.contact.name && <> ({selected.contact.email})</>}
                {" · "}
                {flowNames.get(selected.flow_id) ?? "Unknown flow"}
                {selected.flow_step_order !== null && ` · step ${selected.flow_step_order}`}
              </p>
            </div>

            {selected.status_reason?.startsWith("value_gate:") && (
              <p className="mx-5 mt-4 shrink-0 rounded-md border border-warning bg-warning-soft px-4 py-3 text-body text-foreground" role="note">
                <span className="font-medium">The value gate objected to this draft.</span>{" "}
                {selected.status_reason.replace(/^value_gate:\s*/, "")} You decide: approve, edit, revise or reject it.
              </p>
            )}

            {showRevise && !editing && (
              <div className="shrink-0 border-b border-border">
                <RevisePanel
                  message={selected}
                  drafting={drafting}
                  disabled={regenerate.isPending || exclude.isPending}
                  submitting={revise.isPending}
                  onSubmit={handleRevise}
                  inputRef={reviseInput}
                  onClose={drafting ? undefined : () => setReviseOpen(false)}
                />
              </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @3xl:flex-row @3xl:overflow-hidden">
              <div
                className={cn("flex shrink-0 flex-col p-4 transition-opacity duration-(--dur-fast) @3xl:min-h-0 @3xl:shrink @3xl:flex-1 @3xl:overflow-y-auto", drafting && "opacity-50")}
                aria-busy={drafting}
              >
                {editing ? (
                  <DraftEditor
                    message={selected}
                    onDone={(text, error) => {
                      setEditing(false);
                      if (text) showToast({ text, tone: error ? "error" : undefined });
                    }}
                  />
                ) : (
                  <DraftBody message={selected} />
                )}
              </div>
              <aside
                aria-label="Draft context"
                className="shrink-0 border-t border-border @3xl:w-[18rem] @3xl:overflow-y-auto @3xl:border-l @3xl:border-t-0 @6xl:w-[22rem]"
              >
                <ContextRail message={selected} flowName={flowNames.get(selected.flow_id)} />
              </aside>
            </div>
          </section>
        )}
      </div>
    );
  }

  return (
    <>
      {body}
      <Toast toast={toast} onClose={clearToast} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Approved view
// ---------------------------------------------------------------------------

/** A plain card for the secondary views. */
function ListCard({ intro, children }: { intro: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card shadow-card">
      <p className="border-b border-border px-6 py-4 text-body text-muted-foreground">{intro}</p>
      <div className="px-6">{children}</div>
    </div>
  );
}

function ListEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-10 text-body text-muted-foreground">{children}</p>;
}

/**
 * Approved messages the drain has not sent yet: a reviewer can cancel one
 * (terminal) or pull it back into the review queue.
 */
function ApprovedView() {
  const approved = useApprovedMessages();
  const cancel = useCancelMessage();
  const unapprove = useUnapproveMessage();
  const [error, setError] = useState<string | null>(null);
  const items = approved.data?.messages ?? [];
  return (
    <ListCard intro="Approved drafts go out through the send path: send window, throttle and suppression. Until they do, you can pull one back to review or cancel it.">
      {approved.isLoading ? (
        <div className="space-y-2 py-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : items.length === 0 ? (
        <ListEmpty>No approved drafts are waiting to send.</ListEmpty>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-4 py-3.5">
              <div className="min-w-0">
                <p className="truncate text-body font-medium text-foreground">{m.subject ?? "(no subject)"}</p>
                <p className="mt-0.5 truncate text-small text-muted-foreground">
                  to {contactLabel(m)}
                  {m.waiting_reason ? ` · ${m.waiting_reason}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={unapprove.isPending}
                  onClick={() => {
                    setError(null);
                    unapprove.mutate(m.id, { onError: (err) => setError(actionErrorText(err)) });
                  }}
                >
                  Back to review
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cancel.isPending}
                  onClick={() => {
                    setError(null);
                    cancel.mutate(m.id, { onError: (err) => setError(actionErrorText(err)) });
                  }}
                >
                  Cancel send
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="pb-4 text-body text-muted-foreground" role="status">
          {error}
        </p>
      )}
    </ListCard>
  );
}

// ---------------------------------------------------------------------------
// Needs attention view
// ---------------------------------------------------------------------------

/**
 * Messages that never reach the queue on their own, shown because they are
 * otherwise invisible:
 * - 'value_gated': drafts the value gate held in a flow that sends without
 *   review. They can be sent to review (the reason travels with them) or
 *   dismissed. Flows that need approval never hold a draft; the gate's
 *   objection shows on the draft in the queue instead.
 * - 'failed': generation faults (no LLM configured, bad key, unknown model)
 *   and exhausted send retries. Generation failures can be re-queued once
 *   the fault is fixed.
 * The reason recorded by the worker is shown verbatim.
 */
function AttentionView() {
  const failed = useFailedMessages();
  const held = useHeldMessages();
  const retry = useRetryMessage();
  const release = useReleaseMessage();
  const dismiss = useDismissMessage();
  const flowsQuery = useFlows();

  const flowNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of flowsQuery.data?.flows ?? []) map.set(f.id, f.name);
    return map;
  }, [flowsQuery.data]);

  const items = failed.data?.messages ?? [];
  const heldItems = held.data?.messages ?? [];
  const loading = failed.isLoading || held.isLoading;
  const actionError = [retry, release, dismiss].find((m) => m.isError)?.error;

  if (!loading && items.length + heldItems.length === 0) {
    return (
      <ListCard intro="Drafts the value gate held and messages that stopped permanently show here.">
        <ListEmpty>Nothing needs attention.</ListEmpty>
      </ListCard>
    );
  }

  return (
    <div className="space-y-6">
      {loading && (
        <div className="rounded-lg border border-border bg-card p-6 shadow-card">
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {heldItems.length > 0 && (
        <ListCard
          intro={
            <>
              <span className="font-medium text-foreground">Held by the value gate.</span> These drafts were not sent. Read the reason,
              then send a draft to review or dismiss it.
            </>
          }
        >
          <ul className="divide-y divide-border">
            {heldItems.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <p className="text-body font-medium text-foreground">
                    {flowNames.get(m.flow_id) ?? "Unknown flow"}
                    <span className="ml-2 text-small font-normal text-muted-foreground">to {contactLabel(m)}</span>
                  </p>
                  {m.subject && <p className="mt-0.5 text-body text-foreground">{m.subject}</p>}
                  <p className="mt-0.5 text-body text-muted-foreground">
                    {m.brain_reasoning?.replace(/^value_gated:\s*/, "") ?? "Held by the value gate."}
                  </p>
                  <p className="mt-0.5 font-mono text-small text-subtle-foreground">{formatDate(m.updated_at)}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" onClick={() => dismiss.mutate(m.id)} disabled={dismiss.isPending}>
                    Dismiss
                  </Button>
                  <Button size="sm" onClick={() => release.mutate(m.id)} disabled={release.isPending}>
                    Send to review
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </ListCard>
      )}
      {items.length > 0 && (
        <ListCard
          intro={
            <>
              <span className="font-medium text-foreground">Failed.</span> These messages stopped permanently. The reason is recorded on
              each; fix the cause, then retry generation failures.
            </>
          }
        >
          <ul className="divide-y divide-border">
            {items.map((m) => {
              const retryable = m.brain_reasoning?.startsWith("generation_failed:") ?? false;
              return (
                <li key={m.id} className="flex items-start justify-between gap-4 py-3.5">
                  <div className="min-w-0">
                    <p className="text-body font-medium text-foreground">
                      {flowNames.get(m.flow_id) ?? "Unknown flow"}
                      <span className="ml-2 text-small font-normal text-muted-foreground">to {contactLabel(m)}</span>
                    </p>
                    <p className="mt-0.5 text-body text-muted-foreground">{m.brain_reasoning ?? "Send failed permanently after retries."}</p>
                    <p className="mt-0.5 font-mono text-small text-subtle-foreground">{formatDate(m.updated_at)}</p>
                  </div>
                  {retryable && (
                    <Button variant="outline" size="sm" onClick={() => retry.mutate(m.id)} disabled={retry.isPending}>
                      Retry generation
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </ListCard>
      )}
      {actionError != null && (
        <p className="text-body text-danger">
          {actionError instanceof Error ? actionError.message : ((actionError as { message?: string }).message ?? "The action failed.")}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const VIEWS: Array<{ id: ApprovalsView; label: string }> = [
  { id: "review", label: "To review" },
  { id: "approved", label: "Approved" },
  { id: "attention", label: "Needs attention" },
];

export default function ApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const view = parseView(params.get("view"));
  const queue = useMessageQueue();
  const approved = useApprovedMessages();
  const failed = useFailedMessages();
  const held = useHeldMessages();

  const reviewCount = queue.data?.pages.reduce((n, p) => n + p.messages.length, 0) ?? 0;
  const counts: Record<ApprovalsView, number> = {
    review: reviewCount,
    approved: approved.data?.messages.length ?? 0,
    attention: (failed.data?.messages.length ?? 0) + (held.data?.messages.length ?? 0),
  };

  // P5b: drafts held back because the product's daily LLM token budget is spent.
  const waitingForBudget = useQuery({
    queryKey: ["messages", "pending_generation", "llm_budget"],
    queryFn: () => fetchMessages(undefined, "pending_generation"),
    select: (page) => page.messages.filter((m) => m.status_reason === "llm_budget").length,
    refetchInterval: 60_000,
  });

  function selectView(next: ApprovalsView) {
    setParams(next === "review" ? {} : { view: next }, { replace: true });
  }

  // Refetches every message list on the page (queue, approved, attention,
  // budget notice). The icon makes at least one full turn (animate-spin is 1s) so a fast response still
  // reads as a refresh. Decisions still in their undo window stay hidden.
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    const minTurn = new Promise((r) => window.setTimeout(r, 1000));
    await Promise.allSettled([qc.refetchQueries({ queryKey: MESSAGES_QUERY_KEY, type: "active" }), minTurn]);
    setRefreshing(false);
  }

  return (
    <div className="mx-auto flex max-w-[96rem] flex-col lg:h-full">
      <div className="mb-5 flex shrink-0 flex-wrap items-end gap-x-10 gap-y-2 border-b border-border">
        <h1 className="pb-3 font-display text-headline font-bold tracking-[-0.02em] text-foreground">Approvals</h1>
        <div role="tablist" aria-label="Approvals views" className="flex gap-6">
          {VIEWS.map((v) => {
            const active = v.id === view;
            const count = counts[v.id];
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectView(v.id)}
                className={cn(
                  "-mb-px flex items-center gap-2 border-b-2 pb-3 pt-1 text-body font-medium transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-accent-deep text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {v.label}
                {count > 0 && (
                  <span
                    className={cn(
                      "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 font-mono text-micro",
                      v.id === "attention" ? "bg-danger-soft text-danger" : active ? "bg-accent-soft text-accent-text" : "bg-sunken text-muted-foreground",
                    )}
                  >
                    {count}
                    {v.id === "review" && queue.hasNextPage ? "+" : ""}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mb-2 ml-auto"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw className={cn(refreshing && "animate-spin")} aria-hidden />
          Refresh
        </Button>
      </div>

      {(waitingForBudget.data ?? 0) > 0 && (
        <p className="mb-4 shrink-0 rounded-md border border-border bg-card px-4 py-3 text-body text-foreground" role="status">
          {waitingForBudget.data} {waitingForBudget.data === 1 ? "draft waits" : "drafts wait"} for tomorrow&apos;s LLM budget (status reason{" "}
          <code className="font-mono text-small">llm_budget</code>): the product&apos;s daily token budget (settings.llm_daily_token_budget) is spent.
          They are drafted after midnight UTC.
        </p>
      )}

      {view === "review" && <ReviewView approvedCount={counts.approved} attentionCount={counts.attention} />}
      {view === "approved" && <ApprovedView />}
      {view === "attention" && <AttentionView />}
    </div>
  );
}
