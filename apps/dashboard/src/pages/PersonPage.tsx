/**
 * Person detail page.
 *
 * One person: identity and lifecycle state up top, the merged timeline as
 * the main column, and a right rail with profile facts, properties, and
 * flow memberships. The timeline keeps the three kinds distinct: an event
 * shows its name, the client context it arrived with (browser, OS, ip),
 * and on demand its payload; a transition shows the state change and what
 * caused it; a message links to the mail as it was sent (Sent Mail detail,
 * which links on to the flow step and its template).
 *
 * The rail also holds the team's notes about the person and the actions:
 * exclude from lifecycle mail (any member) and delete the person (owners
 * only, confirmed by typing the person's email or user id).
 */
import React, { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Zap, RefreshCw, Mail, X, Pencil } from "lucide-react";
import {
  useContact,
  useContactTimeline,
  useContactNotes,
  useAddContactNote,
  useDeleteContactNote,
  useSetContactTopics,
  useDeleteContact,
  useSetContactName,
} from "../contacts.js";
import { useExcludeContact } from "../messages.js";
import { useMe } from "../auth.js";
import type { ContactDetail, ContactTopicStatus, TimelineItem } from "../api.js";
import { Textarea } from "../components/ui/textarea.js";
import { Input } from "../components/ui/input.js";
import { Badge, type BadgeVariant } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { cn } from "../lib/utils.js";
import { stateHint, stateName } from "../lib/lifecycle-names.js";

function stateVariant(state: ContactDetail["lifecycle_state"]): BadgeVariant {
  switch (state) {
    case "signed_up": return "neutral";
    case "activated": return "accent";
    case "engaged": return "success";
    case "at_risk": return "warning";
    case "dormant": return "muted";
    case "gone_quiet": return "danger";
    // Older servers (before the gone_quiet rename) return churned.
    case "churned": return "danger";
    case "resurrected": return "success";
  }
}

function membershipVariant(status: string): BadgeVariant {
  switch (status) {
    case "active": return "success";
    case "paused": return "warning";
    case "completed": return "muted";
    case "exited": return "neutral";
    default: return "neutral";
  }
}

function messageVariant(status: string): BadgeVariant {
  switch (status) {
    case "sent": return "success";
    case "approved": return "accent";
    case "pending_approval": return "warning";
    case "rejected":
    case "failed":
    case "suppressed": return "danger";
    case "skipped":
    case "value_gated": return "muted";
    default: return "neutral";
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Timeline helpers
// ---------------------------------------------------------------------------

const KIND_ICON = {
  event: Zap,
  transition: RefreshCw,
  message: Mail,
} as const;

/** Timeline node tint per item kind: events are signal, messages are
 *  delivered work, transitions stay quiet. */
const KIND_TONE: Record<TimelineItem["kind"], string> = {
  event: "border-transparent bg-accent-soft text-accent-text",
  transition: "border-transparent bg-sunken text-muted-foreground",
  message: "border-transparent bg-success-soft text-success",
};

/**
 * One-line summary of the client context an event arrived with. Renders
 * the shallow scalar entries ("browser: Safari", "ip: 1.2.3.4"); nested
 * objects stay inside the payload disclosure.
 */
function contextSummary(context: Record<string, unknown> | null): string | null {
  if (!context) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    parts.push(`${key}: ${String(value)}`);
    if (parts.length >= 3) break;
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** What caused a transition, from its metadata ("via scan", or the event). */
function transitionCause(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  if (metadata.trigger === "scan") return "via scan";
  if (typeof metadata.trigger === "string") return `via ${metadata.trigger}`;
  return null;
}

function StateChip({ state }: { state: string }) {
  return (
    <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-caption text-foreground">
      {stateName(state)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Timeline items
// ---------------------------------------------------------------------------

function TimelineRow({ item, last, contactId }: { item: TimelineItem; last: boolean; contactId: string }) {
  const Icon = KIND_ICON[item.kind];
  return (
    <li className="relative flex gap-4 pb-5 last:pb-0">
      {!last && (
        <span
          aria-hidden="true"
          className="absolute left-[11px] top-6 h-full w-px bg-border"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          "z-10 mt-1 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border",
          KIND_TONE[item.kind],
        )}
      >
        <Icon size={12} strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        {item.kind === "event" && (
          <div>
            <p className="text-body text-foreground">
              <code className="font-mono text-small">{item.event_name ?? item.event_type}</code>
            </p>
            {contextSummary(item.context) && (
              <p className="mt-0.5 font-mono text-caption text-subtle-foreground">
                {contextSummary(item.context)}
              </p>
            )}
            {item.properties && Object.keys(item.properties).length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer select-none text-small text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground">
                  payload
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 font-mono text-caption text-muted-foreground">
                  {JSON.stringify(item.properties, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
        {item.kind === "transition" && (
          <div>
            <p className="flex flex-wrap items-center gap-2 text-body text-foreground">
              <StateChip state={item.from_state} />
              <span aria-hidden="true" className="text-subtle-foreground">{"->"}</span>
              <StateChip state={item.to_state} />
              {transitionCause(item.metadata) && (
                <span className="text-small text-muted-foreground">
                  {transitionCause(item.metadata)}
                </span>
              )}
            </p>
          </div>
        )}
        {item.kind === "message" && (
          <div>
            <p className="text-body text-foreground">
              <Link
                to={`/sent/${item.id}`}
                state={{ fromPerson: contactId }}
                className="text-accent-text underline underline-offset-4"
              >
                {item.subject ?? "(no subject)"}
              </Link>
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-small text-muted-foreground">
              <Badge variant={messageVariant(item.status)}>{item.status}</Badge>
              {item.feedback && (
                <span className="font-mono">{item.feedback}</span>
              )}
              <span>{item.flow_name}</span>
              {item.flow_step_order !== null && <span>step {item.flow_step_order}</span>}
            </p>
          </div>
        )}
        <p className="mt-1 font-mono text-caption text-subtle-foreground">
          {formatDateTime(item.occurred_at)}
        </p>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Rail cards
// ---------------------------------------------------------------------------

function RailCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card shadow-card p-6">
      <h2 className="mb-4 text-title font-semibold leading-6 tracking-[-0.01em] text-foreground">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Fact({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-1">
      <dt className="max-w-[60%] shrink-0 text-muted-foreground [overflow-wrap:anywhere]">{label}</dt>
      <dd className={cn(
        "min-w-0 text-right [overflow-wrap:anywhere]",
        mono ? "font-mono text-small text-muted-foreground" : "text-foreground",
      )}>
        {value}
      </dd>
    </div>
  );
}

/**
 * A property row. Scalars sit on one line like a Fact; objects and arrays
 * go under their key as indented JSON, since a one-line JSON blob cannot
 * fit the rail.
 */
function PropertyFact({ label, value }: { label: string; value: unknown }) {
  if (value === null || typeof value !== "object") {
    return <Fact label={label} value={typeof value === "string" ? value : JSON.stringify(value)} />;
  }
  return (
    <div className="py-1">
      <dt className="text-muted-foreground [overflow-wrap:anywhere]">{label}</dt>
      <dd className="mt-1">
        <pre className="whitespace-pre-wrap rounded-md bg-sunken px-2 py-1.5 font-mono text-caption text-muted-foreground [overflow-wrap:anywhere]">
          {JSON.stringify(value, null, 2)}
        </pre>
      </dd>
    </div>
  );
}

/** Properties shown before "Show all": about five rows of the two-column grid. */
const PROPERTIES_PREVIEW = 10;

function PropertiesCard({ entries }: { entries: Array<[string, unknown]> }) {
  const [all, setAll] = useState(false);
  // Scalars first in the grid; objects and arrays take a full row each, after them.
  const sorted = useMemo(
    () => [
      ...entries.filter(([, v]) => v === null || typeof v !== "object"),
      ...entries.filter(([, v]) => v !== null && typeof v === "object"),
    ],
    [entries],
  );
  const shown = all ? sorted : sorted.slice(0, PROPERTIES_PREVIEW);
  return (
    <RailCard title="Properties">
      {entries.length === 0 ? (
        <p className="text-body text-muted-foreground">
          No properties recorded. Anything sent with identify calls or
          event payloads lands here.
        </p>
      ) : (
        <>
          <dl className="grid gap-x-8 sm:grid-cols-2">
            {shown.map(([key, value]) => (
              <div key={key} className={value !== null && typeof value === "object" ? "sm:col-span-2" : undefined}>
                <PropertyFact label={key} value={value} />
              </div>
            ))}
          </dl>
          {sorted.length > PROPERTIES_PREVIEW && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${sorted.length}`}
            </Button>
          )}
        </>
      )}
    </RailCard>
  );
}

/**
 * The person's name with an edit button. Saving locks the name: identify
 * calls from the app no longer change it (see NameLockNote).
 */
function NameHeading({ contactId, displayName, name }: { contactId: string; displayName: string; name: string | null }) {
  const set = useSetContactName(contactId);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (draft === null) {
    return (
      <div className="flex items-center gap-1.5">
        <h1 className="font-display text-display font-bold tracking-[-0.02em] text-foreground">
          {displayName}
        </h1>
        <button
          type="button"
          aria-label="Edit name"
          title="Edit name"
          onClick={() => { setError(null); setDraft(name ?? ""); }}
          className="rounded-md p-1.5 text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-sunken-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Pencil className="size-4" aria-hidden />
        </button>
      </div>
    );
  }

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    if (!value) { setError("A name needs some text."); return; }
    set.mutate(value, {
      onSuccess: () => setDraft(null),
      onError: (err) => setError(err.message),
    });
  };

  return (
    <form onSubmit={save} className="flex flex-wrap items-center gap-2">
      <Input
        autoFocus
        aria-label="Name"
        value={draft}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") setDraft(null); }}
        className="w-72"
      />
      <Button type="submit" size="sm" disabled={set.isPending}>
        {set.isPending ? "Saving..." : "Save"}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
        Cancel
      </Button>
      {error && <p className="w-full text-small text-danger" role="alert">{error}</p>}
    </form>
  );
}

/** Shown while the name is locked, with the way back to the app's value. */
function NameLockNote({ contactId }: { contactId: string }) {
  const set = useSetContactName(contactId);
  return (
    <p className="mt-1 text-small text-subtle-foreground">
      Name edited here, so identify calls no longer change it.{" "}
      <button
        type="button"
        disabled={set.isPending}
        title="The current name stays until your app next sends one with identify."
        onClick={() => set.mutate(null)}
        className="text-accent-text underline underline-offset-4 disabled:cursor-wait"
      >
        Use the name from your app
      </button>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PersonPage() {
  const { id } = useParams<{ id: string }>();
  const contactQuery = useContact(id ?? "");
  const timeline = useContactTimeline(id ?? "");

  const items = useMemo(
    () => timeline.data?.pages.flatMap((p) => p.items) ?? [],
    [timeline.data],
  );

  if (contactQuery.isLoading) {
    return (
      <div className="mx-auto max-w-[90rem] space-y-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-7 w-64" />
        <div className="flex gap-8">
          <Skeleton className="h-96 flex-1" />
          <Skeleton className="hidden h-96 w-72 lg:block" />
        </div>
      </div>
    );
  }

  if (contactQuery.isError || !contactQuery.data) {
    return (
      <div className="mx-auto max-w-[90rem]">
        <div
          className="rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-lead text-foreground">
            Failed to load this person:{" "}
            {contactQuery.error instanceof Error
              ? contactQuery.error.message
              : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  const { contact, memberships, suppression } = contactQuery.data;
  const topicStatuses = contactQuery.data.topics ?? [];
  const displayName = contact.name ?? contact.email ?? contact.external_id;
  const propertyEntries = Object.entries(contact.properties ?? {});

  return (
    <div className="mx-auto max-w-[90rem]">
      {/* Header */}
      <div className="mb-8">
        <Link
          to="/people"
          className="text-body text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground"
        >
          &larr; People
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <NameHeading
            contactId={contact.id}
            displayName={displayName}
            name={contact.name}
          />
          <Badge variant={stateVariant(contact.lifecycle_state)} title={stateHint(contact.lifecycle_state)}>
            {stateName(contact.lifecycle_state)}
          </Badge>
          {contact.engagement_depth && (
            <span className="text-body text-muted-foreground">
              {contact.engagement_depth}
            </span>
          )}
          {contact.payment_status && (
            <span className="font-mono text-small text-muted-foreground">
              {contact.payment_status}
            </span>
          )}
        </div>
        <p className="mt-1 text-body text-muted-foreground">
          {contact.company ? (
            <>
              {contact.company}
              {" · "}
            </>
          ) : null}
          <span className="font-mono text-small">{contact.external_id}</span>
        </p>
        {contact.name_locked_at && <NameLockNote contactId={contact.id} />}
      </div>

      {suppression && (
        <div
          className="mb-6 rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-lead text-foreground">
            This address is suppressed ({suppression.reason}
            {suppression.source ? ` via ${suppression.source}` : ""},{" "}
            {formatDate(suppression.created_at)}). The engine will not send
            to it.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-10 lg:flex-row lg:gap-8">
        {/* Timeline (main column) */}
        <div className="min-w-0 flex-1">
          <div className="mb-10 space-y-6">
            <RailCard title="Profile">
              <dl className="grid gap-x-8 sm:grid-cols-2">
                <Fact label="Email" value={contact.email ?? "-"} />
                <Fact label="User id" value={contact.external_id} />
                {contact.company && <Fact label="Company" value={contact.company} mono={false} />}
                <Fact label="Plan" value={contact.payment_status ?? "-"} />
                <Fact label="First seen" value={formatDate(contact.first_seen_at)} />
                <Fact label="Last seen" value={formatDate(contact.last_seen_at)} />
                <Fact label="Activated" value={formatDate(contact.activated_at)} />
                <Fact label="Recorded" value={formatDate(contact.created_at)} />
              </dl>
              <p className="mt-2 text-caption text-subtle-foreground">
                Email, company and plan come from your app's identify calls
                (the <code className="font-mono">plan</code> trait), so they are not edited here.
              </p>
            </RailCard>

            <PropertiesCard entries={propertyEntries} />
          </div>

          <p className="mb-4 text-body font-medium text-foreground">
            Timeline
          </p>

          {timeline.isLoading && (
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}

          {timeline.isError && (
            <div
              className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
              role="alert"
            >
              <p className="text-lead text-foreground">
                Failed to load the timeline.
              </p>
              <Button variant="outline" size="sm" onClick={() => timeline.refetch()}>
                Try again
              </Button>
            </div>
          )}

          {!timeline.isLoading && !timeline.isError && items.length === 0 && (
            <div className="rounded-lg border border-dashed border-border-strong px-6 py-12 text-center">
              <p className="text-body text-muted-foreground">
                Nothing has happened to this person yet. Events, lifecycle
                changes, and messages will appear here in order.
              </p>
            </div>
          )}

          {items.length > 0 && (
            <>
              <ol className="list-none">
                {items.map((item, i) => (
                  <TimelineRow
                    key={`${item.kind}-${item.id}`}
                    item={item}
                    last={i === items.length - 1}
                    contactId={contact.id}
                  />
                ))}
              </ol>
              {timeline.hasNextPage && (
                <div className="mt-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={timeline.isFetchingNextPage}
                    onClick={() => timeline.fetchNextPage()}
                  >
                    {timeline.isFetchingNextPage ? "Loading..." : "Load earlier"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right rail */}
        <div className="w-full shrink-0 space-y-6 lg:w-72">
          <NotesCard contactId={contact.id} />

          {topicStatuses.length > 0 && (
            <RailCard title="Topics">
              <TopicToggles contactId={id!} topics={topicStatuses} />
            </RailCard>
          )}

          <RailCard title="Flows">
            {memberships.length === 0 ? (
              <p className="text-body text-muted-foreground">
                Not enrolled in any flow.
              </p>
            ) : (
              <ul className="space-y-3">
                {memberships.map((m) => (
                  <li key={m.id}>
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/flows/${m.flow_id}/edit`}
                        className="text-body font-medium text-accent-text underline underline-offset-4"
                      >
                        {m.flow_name}
                      </Link>
                      <Badge variant={membershipVariant(m.status)}>
                        {m.status}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-small text-muted-foreground">
                      {"step "}
                      {m.current_step}
                      {" · entered "}
                      <span className="font-mono">{formatDate(m.entered_at)}</span>
                      {m.completed_at && (
                        <>
                          {" · completed "}
                          <span className="font-mono">{formatDate(m.completed_at)}</span>
                        </>
                      )}
                      {m.exit_reason && ` · exited: ${m.exit_reason}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </RailCard>

          <ActionsCard
            contactId={contact.id}
            label={displayName}
            confirmValue={contact.email ?? contact.external_id}
            suppressed={Boolean(suppression)}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function NotesCard({ contactId }: { contactId: string }) {
  const notes = useContactNotes(contactId);
  const add = useAddContactNote(contactId);
  const remove = useDeleteContactNote(contactId);
  const [draft, setDraft] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    add.mutate(body, { onSuccess: () => setDraft("") });
  };

  const items = notes.data?.items ?? [];

  return (
    <RailCard title="Notes">
      <form onSubmit={submit} className="space-y-2">
        <Textarea
          aria-label="New note"
          placeholder="Add a note for your team"
          value={draft}
          maxLength={5000}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-16 text-body"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption text-subtle-foreground">Only your team sees notes.</span>
          <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim() || add.isPending}>
            {add.isPending ? "Saving..." : "Add note"}
          </Button>
        </div>
        {add.isError && (
          <p className="text-small text-danger" role="alert">
            {add.error instanceof Error ? add.error.message : "Saving the note failed."}
          </p>
        )}
      </form>

      {notes.isError && (
        <p className="mt-3 text-small text-danger" role="alert">Failed to load notes.</p>
      )}
      {items.length > 0 && (
        <ul className="mt-4 space-y-3">
          {items.map((n) => (
            <li key={n.id} className="group rounded-md bg-sunken px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 whitespace-pre-wrap break-words text-body text-foreground">{n.body}</p>
                <button
                  type="button"
                  aria-label="Delete note"
                  title="Delete note"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm("Delete this note?")) remove.mutate(n.id);
                  }}
                  className="shrink-0 rounded p-0.5 text-subtle-foreground transition-colors duration-(--dur-fast) hover:text-foreground"
                >
                  <X size={14} strokeWidth={1.5} />
                </button>
              </div>
              <p className="mt-1 text-caption text-subtle-foreground">
                {n.author ? (n.author.name ?? n.author.email ?? "Removed member") : "Unknown"}
                {" · "}
                <span className="font-mono">{formatDateTime(n.created_at)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </RailCard>
  );
}

// ---------------------------------------------------------------------------
// Actions: exclude, delete
// ---------------------------------------------------------------------------

function ActionsCard({
  contactId,
  label,
  confirmValue,
  suppressed,
}: {
  contactId: string;
  label: string;
  confirmValue: string;
  suppressed: boolean;
}) {
  const navigate = useNavigate();
  const me = useMe();
  const isOwner = me.data?.user.role === "owner";
  const exclude = useExcludeContact();
  const erase = useDeleteContact();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [excludeResult, setExcludeResult] = useState<string | null>(null);

  const onExclude = () => {
    if (!window.confirm(`Exclude ${label} from lifecycle mail? Their address is suppressed and every message not sent yet is cancelled. Undo by removing the suppression under Sent Mail.`)) return;
    exclude.mutate(contactId, {
      onSuccess: (r) => {
        setExcludeResult(
          `${r.suppressed ? "Suppressed. " : ""}${r.cancelled.length} unsent ${r.cancelled.length === 1 ? "message" : "messages"} cancelled.`,
        );
      },
    });
  };

  const onDelete = (e: React.FormEvent) => {
    e.preventDefault();
    if (typed.trim().toLowerCase() !== confirmValue.toLowerCase()) return;
    erase.mutate(contactId, { onSuccess: () => navigate("/people", { replace: true }) });
  };

  return (
    <RailCard title="Actions">
      <div className="space-y-4">
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={suppressed || exclude.isPending}
            onClick={onExclude}
          >
            {exclude.isPending ? "Excluding..." : "Exclude from mail"}
          </Button>
          <p className="mt-1.5 text-caption text-subtle-foreground">
            {suppressed
              ? "This address is already suppressed."
              : "Stops lifecycle mail to this person and keeps their history."}
          </p>
          {excludeResult && <p className="mt-1.5 text-small text-foreground">{excludeResult}</p>}
          {exclude.isError && (
            <p className="mt-1.5 text-small text-danger" role="alert">
              {exclude.error instanceof Error ? exclude.error.message : "Exclude failed."}
            </p>
          )}
        </div>

        {isOwner && (
          <div>
            {!confirming ? (
              <Button variant="outline" size="sm" className="text-danger" onClick={() => setConfirming(true)}>
                Delete person
              </Button>
            ) : (
              <form onSubmit={onDelete} className="space-y-2 rounded-md border border-danger bg-danger-soft p-3">
                <p className="text-small text-foreground">
                  This erases {label} from this product: events, flow memberships,
                  messages, notes and topic choices. Suppressions stay, so the address
                  is not mailed again. It cannot be undone. If your app sends this
                  person again, they come back as a new contact.
                </p>
                <label className="block text-small text-foreground">
                  Type <code className="font-mono">{confirmValue}</code> to confirm
                  <Input
                    autoFocus
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    className="mt-1 h-8 text-body"
                  />
                </label>
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    variant="destructive"
                    disabled={typed.trim().toLowerCase() !== confirmValue.toLowerCase() || erase.isPending}
                  >
                    {erase.isPending ? "Deleting..." : "Delete"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setConfirming(false);
                      setTyped("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
                {erase.isError && (
                  <p className="text-small text-danger" role="alert">
                    {erase.error instanceof Error ? erase.error.message : "Delete failed."}
                  </p>
                )}
              </form>
            )}
          </div>
        )}
      </div>
    </RailCard>
  );
}

/**
 * The person's topic subscriptions with a switch per marketing or lifecycle
 * topic. A change is recorded with source "admin" and fires the same
 * contact.subscribed / contact.unsubscribed webhooks as the person's own
 * choice. Transactional topics have no subscription; only the suppression
 * list stops them.
 */
function TopicToggles({ contactId, topics }: { contactId: string; topics: ContactTopicStatus[] }) {
  const set = useSetContactTopics(contactId);
  const [error, setError] = React.useState<string | null>(null);
  const pendingSlug = set.isPending ? Object.keys(set.variables ?? {})[0] : null;
  return (
    <div>
      <ul className="space-y-2.5">
        {topics.map((t) => {
          const on = t.status === "subscribed";
          const title = t.default ? "Topic default (no choice recorded)" : t.source ? `Set via ${t.source}` : undefined;
          return (
            <li key={t.topic_id} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-body text-foreground" title={title}>
                {t.name}
                {t.kind !== "transactional" && t.default && <span className="text-muted-foreground"> (default)</span>}
              </span>
              {t.kind === "transactional" ? (
                <Badge variant="muted">transactional</Badge>
              ) : (
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`${on ? "Unsubscribe from" : "Subscribe to"} ${t.name}`}
                  title={title}
                  disabled={set.isPending}
                  onClick={() => {
                    setError(null);
                    set.mutate({ [t.slug]: !on }, { onError: (e) => setError(e.message) });
                  }}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait ${
                    on ? "bg-accent" : "bg-sunken border border-border-strong"
                  } ${pendingSlug === t.slug ? "opacity-60" : ""}`}
                >
                  <span
                    aria-hidden="true"
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-background transition-transform duration-(--dur-fast) ${on ? "translate-x-[18px]" : "translate-x-[3px]"}`}
                  />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="mt-2 text-small text-danger" role="alert">{error}</p>}
      <p className="mt-3 text-caption text-muted-foreground">
        Changes here are recorded as set by your team. To stop all mail, use Exclude from mail.
      </p>
    </div>
  );
}
