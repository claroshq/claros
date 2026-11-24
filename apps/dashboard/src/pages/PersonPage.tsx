/**
 * Person detail page.
 *
 * One person: identity and lifecycle state up top, the merged timeline as
 * the main column, and a right rail with profile facts, properties, and
 * flow memberships. The timeline keeps the three kinds distinct: an event
 * shows its name, the client context it arrived with (browser, OS, ip),
 * and on demand its payload; a transition shows the state change and what
 * caused it; a message shows the draft and where it came from. Flows link
 * to the flow editor.
 */
import React, { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { Zap, RefreshCw, Mail } from "lucide-react";
import { useContact, useContactTimeline } from "../contacts.js";
import type { ContactDetail, TimelineItem } from "../api.js";
import { Badge, type BadgeVariant } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { cn } from "../lib/utils.js";

function stateVariant(state: ContactDetail["lifecycle_state"]): BadgeVariant {
  switch (state) {
    case "signed_up": return "neutral";
    case "activated": return "accent";
    case "engaged": return "success";
    case "at_risk": return "warning";
    case "dormant": return "muted";
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
    <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[12px] text-foreground">
      {state}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Timeline items
// ---------------------------------------------------------------------------

function TimelineRow({ item, last }: { item: TimelineItem; last: boolean }) {
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
            <p className="text-[14px] text-foreground">
              <code className="font-mono text-[13px]">{item.event_name ?? item.event_type}</code>
            </p>
            {contextSummary(item.context) && (
              <p className="mt-0.5 font-mono text-[12px] text-subtle-foreground">
                {contextSummary(item.context)}
              </p>
            )}
            {item.properties && Object.keys(item.properties).length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer select-none text-[13px] text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground">
                  payload
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 font-mono text-[12px] text-muted-foreground">
                  {JSON.stringify(item.properties, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
        {item.kind === "transition" && (
          <div>
            <p className="flex flex-wrap items-center gap-2 text-[14px] text-foreground">
              <StateChip state={item.from_state} />
              <span aria-hidden="true" className="text-subtle-foreground">{"->"}</span>
              <StateChip state={item.to_state} />
              {transitionCause(item.metadata) && (
                <span className="text-[13px] text-muted-foreground">
                  {transitionCause(item.metadata)}
                </span>
              )}
            </p>
          </div>
        )}
        {item.kind === "message" && (
          <div>
            <p className="text-[14px] text-foreground">
              <Link
                to={`/sent/${item.id}`}
                className="hover:underline underline-offset-4"
              >
                {item.subject ?? "(no subject)"}
              </Link>
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
              <Badge variant={messageVariant(item.status)}>{item.status}</Badge>
              {item.feedback && (
                <span className="font-mono">{item.feedback}</span>
              )}
              <Link
                to={`/flows/${item.flow_id}/edit`}
                className="text-accent-text underline underline-offset-4"
              >
                {item.flow_name}
              </Link>
              {item.flow_step_order !== null && <span>step {item.flow_step_order}</span>}
            </p>
          </div>
        )}
        <p className="mt-1 font-mono text-[12px] text-subtle-foreground">
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
    <div className="rounded-lg border border-border bg-card p-5">
      <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function Fact({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn(
        "text-right",
        mono ? "font-mono text-[13px] text-muted-foreground" : "text-foreground",
      )}>
        {value}
      </dd>
    </div>
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
      <div className="mx-auto max-w-6xl space-y-4">
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
      <div className="mx-auto max-w-6xl">
        <div
          className="rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[15px] text-foreground">
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
  const displayName = contact.name ?? contact.email ?? contact.external_id;
  const propertyEntries = Object.entries(contact.properties ?? {});

  return (
    <div className="mx-auto max-w-6xl">
      {/* Header */}
      <div className="mb-8">
        <Link
          to="/people"
          className="text-[14px] text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground"
        >
          &larr; People
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-display text-[28px] font-bold leading-[34px] tracking-[-0.02em] text-foreground">
            {displayName}
          </h1>
          <Badge variant={stateVariant(contact.lifecycle_state)}>
            {contact.lifecycle_state}
          </Badge>
          {contact.engagement_depth && (
            <span className="text-[14px] text-muted-foreground">
              {contact.engagement_depth}
            </span>
          )}
          {contact.payment_status && (
            <span className="font-mono text-[13px] text-muted-foreground">
              {contact.payment_status}
            </span>
          )}
        </div>
        <p className="mt-1 text-[14px] text-muted-foreground">
          {contact.company ? (
            <>
              {contact.company}
              {" · "}
            </>
          ) : null}
          <span className="font-mono text-[13px]">{contact.external_id}</span>
        </p>
      </div>

      {suppression && (
        <div
          className="mb-6 rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[15px] text-foreground">
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
          <p className="mb-4 text-[14px] font-medium text-foreground">
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
              <p className="text-[15px] text-foreground">
                Failed to load the timeline.
              </p>
              <Button variant="outline" size="sm" onClick={() => timeline.refetch()}>
                Try again
              </Button>
            </div>
          )}

          {!timeline.isLoading && !timeline.isError && items.length === 0 && (
            <div className="rounded-lg border border-dashed border-border-strong px-6 py-12 text-center">
              <p className="text-[14px] text-muted-foreground">
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
          <RailCard title="Profile">
            <dl>
              <Fact label="Email" value={contact.email ?? "-"} />
              <Fact label="User id" value={contact.external_id} />
              {contact.company && <Fact label="Company" value={contact.company} mono={false} />}
              <Fact label="First seen" value={formatDate(contact.first_seen_at)} />
              <Fact label="Last seen" value={formatDate(contact.last_seen_at)} />
              <Fact label="Activated" value={formatDate(contact.activated_at)} />
              <Fact label="Recorded" value={formatDate(contact.created_at)} />
            </dl>
          </RailCard>

          <RailCard title="Properties">
            {propertyEntries.length === 0 ? (
              <p className="text-[14px] text-muted-foreground">
                No properties recorded. Anything sent with identify calls or
                event payloads lands here.
              </p>
            ) : (
              <dl>
                {propertyEntries.map(([key, value]) => (
                  <Fact
                    key={key}
                    label={key}
                    value={
                      typeof value === "string" ? value : JSON.stringify(value)
                    }
                  />
                ))}
              </dl>
            )}
          </RailCard>

          <RailCard title="Flows">
            {memberships.length === 0 ? (
              <p className="text-[14px] text-muted-foreground">
                Not enrolled in any flow.
              </p>
            ) : (
              <ul className="space-y-3">
                {memberships.map((m) => (
                  <li key={m.id}>
                    <div className="flex items-center gap-2">
                      <Link
                        to={`/flows/${m.flow_id}/edit`}
                        className="text-[14px] font-medium text-accent-text underline underline-offset-4"
                      >
                        {m.flow_name}
                      </Link>
                      <Badge variant={membershipVariant(m.status)}>
                        {m.status}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">
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
        </div>
      </div>
    </div>
  );
}
