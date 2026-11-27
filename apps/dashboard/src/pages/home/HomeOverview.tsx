/**
 * Home, operational mode: what needs you, then what happened.
 *
 * The page always renders the same skeleton, whatever needs attention:
 *   1. Needs you: approvals (with the first drafts inline), failures,
 *      compile errors, ingestion gaps, deliverability and lifecycle signals.
 *      Collapses to one quiet line when nothing does.
 *   2. This week: sent, opens, new people, events, each with its own link.
 *   3. Main column: recent activity (mail sent, people who joined, knowledge
 *      base edits, merged by time) and the active flows with their week.
 *   4. Side column: lifecycle movement, connect your AI (MCP), knowledge
 *      base, and the docs, community and tip of the day.
 *
 * Every number comes from an existing dashboard endpoint; nothing here is
 * estimated or sampled. Each block loads on its own, so a slow query never
 * blanks the page.
 */
import React from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  Inbox,
  Lightbulb,
  Mail,
  MessagesSquare,
  Shield,
  UserPlus,
  XCircle,
  Zap,
} from "lucide-react";
import { PageHeader } from "../../components/page-header.js";
import { Badge } from "../../components/ui/badge.js";
import { buttonVariants } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { TrendLine, fillDays, type DailyPoint } from "../../components/charts.js";
import { cn } from "../../lib/utils.js";
import { ago } from "../../lib/time.js";
import { stateName } from "../../lib/lifecycle-names.js";
import { triggerEvents } from "../../lib/flow-model.js";
import { useIngestKeys, useIngestStatus } from "../../ingestion.js";
import {
  useHomeFailedMessages,
  useHomeKb,
  useHomeLifecycle,
  useHomeNewPeople,
  useHomePendingMessages,
  useHomeRecentSent,
  useHomeSending,
} from "../../home.js";
import type { Flow, IngestKey, Message } from "../../api.js";
import { mcpKeyState } from "../connect-ai/mcp.js";

const DAY_MS = 86_400_000;
/** Rates below this many sends are noise (docs/BRAND.md section 10). */
const LOW_VOLUME_SENT = 20;

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function personLabel(c: { name: string | null; email: string | null; external_id: string | null }): string {
  return c.name || c.email || c.external_id || "Unknown person";
}

function triggerLabel(flow: Flow): string {
  const cfg = flow.trigger_config as Record<string, unknown>;
  switch (flow.trigger_type) {
    case "event": {
      const events = triggerEvents(cfg);
      return events.length > 0 ? `on ${events.join(", ")}` : "on an event";
    }
    case "lifecycle_transition":
      return typeof cfg.to === "string" ? `enters ${stateName(cfg.to)}` : "lifecycle transition";
    default:
      return flow.trigger_type.replace(/_/g, " ");
  }
}

// ---------------------------------------------------------------------------
// Section furniture
// ---------------------------------------------------------------------------

function MicroLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h2
      className={cn(
        "text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </h2>
  );
}

function Panel({
  title,
  link,
  children,
  className,
}: {
  title: string;
  link?: { to: string; label: string };
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card", className)}>
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <MicroLabel>{title}</MicroLabel>
        {link && (
          <Link
            to={link.to}
            className="group inline-flex items-center gap-1 text-[13px] text-accent-text"
          >
            {link.label}
            <ArrowRight
              size={12}
              className="transition-transform duration-(--dur-fast) group-hover:translate-x-0.5"
            />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

function PanelSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 px-5 py-4">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

function PanelNote({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-4 text-[13px] leading-[20px] text-muted-foreground">{children}</p>;
}

// ---------------------------------------------------------------------------
// 1. Needs you
// ---------------------------------------------------------------------------

type Tone = "accent" | "danger" | "warning" | "pop";

const TONE: Record<Tone, string> = {
  accent: "bg-accent-soft text-accent-text",
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  pop: "bg-pop-soft text-pop-text",
};

interface AttentionItem {
  key: string;
  icon: React.ElementType;
  tone: Tone;
  title: string;
  description: string;
  linkTo: string;
  linkLabel: string;
  /** Extra rows under the item (the first drafts in the approval queue). */
  detail?: React.ReactNode;
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const Icon = item.icon;
  return (
    <li className="flex items-start gap-4 px-5 py-4">
      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", TONE[item.tone])}>
        <Icon size={16} strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <p className="text-[14px] font-medium text-foreground">{item.title}</p>
          <Link
            to={item.linkTo}
            className="group inline-flex shrink-0 items-center gap-1 text-[13px] text-accent-text"
          >
            {item.linkLabel}
            <ArrowRight
              size={12}
              className="transition-transform duration-(--dur-fast) group-hover:translate-x-0.5"
            />
          </Link>
        </div>
        <p className="mt-0.5 text-[13px] leading-[20px] text-muted-foreground">{item.description}</p>
        {item.detail}
      </div>
    </li>
  );
}

/** The first drafts waiting for review, so the queue is visible without a click. */
function PendingPreview({ messages }: { messages: Message[] }) {
  const shown = messages.slice(0, 3);
  return (
    <ul className="mt-3 divide-y divide-border rounded-md border border-border">
      {shown.map((m) => (
        <li key={m.id}>
          <Link
            to="/approvals"
            className="flex items-center gap-3 px-3 py-2 transition-colors duration-(--dur-fast) hover:bg-secondary"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
              {m.subject || <span className="text-subtle-foreground">Draft without a subject</span>}
            </span>
            <span className="hidden max-w-[30%] truncate text-[12px] text-muted-foreground sm:inline">
              {personLabel(m.contact)}
            </span>
            {m.flow?.name && (
              <span className="hidden max-w-[25%] truncate font-mono text-[12px] text-subtle-foreground md:inline">
                {m.flow.name}
              </span>
            )}
            {m.flow?.class === "critical" && <Badge variant="warning">critical</Badge>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function useAttentionItems(flows: Flow[]) {
  const pending = useHomePendingMessages();
  const failed = useHomeFailedMessages();
  const ingest = useIngestStatus(false);
  const sending = useHomeSending();
  const lifecycle = useHomeLifecycle();

  const isLoading = pending.isLoading || failed.isLoading || ingest.isLoading;
  const items: AttentionItem[] = [];

  const pendingMessages = pending.data?.messages ?? [];
  const pendingMore = pending.data?.next_cursor != null;
  if (pendingMessages.length > 0) {
    const n = pendingMessages.length;
    items.push({
      key: "pending",
      icon: Inbox,
      tone: "accent",
      title: `${pendingMore ? `${n}+` : n} draft${n === 1 && !pendingMore ? "" : "s"} waiting for approval`,
      description: "Nothing is sent until someone approves it. Oldest and critical-class drafts come first.",
      linkTo: "/approvals",
      linkLabel: "Review",
      detail: <PendingPreview messages={pendingMessages} />,
    });
  }

  const failedMessages = failed.data?.messages ?? [];
  if (failedMessages.length > 0) {
    const n = failedMessages.length;
    items.push({
      key: "failed",
      icon: XCircle,
      tone: "danger",
      title: `${n}${failed.data?.next_cursor ? "+" : ""} message${n === 1 ? "" : "s"} failed`,
      description:
        failedMessages.find((m) => m.status_reason)?.status_reason ??
        "They were not sent. Open one to see the error and retry it.",
      linkTo: "/approvals",
      linkLabel: "Approvals",
    });
  }

  const compileErrors = flows.filter((f) => f.compile_status === "failed" && f.status !== "archived");
  if (compileErrors.length > 0) {
    items.push({
      key: "compile",
      icon: AlertTriangle,
      tone: "warning",
      title: `${plural(compileErrors.length, "flow")} failed to compile`,
      description: compileErrors[0]!.compile_error ?? `"${compileErrors[0]!.name}" needs attention.`,
      linkTo: `/flows/${compileErrors[0]!.id}/edit`,
      linkLabel: "Flow editor",
    });
  }

  const eventsLast24h = ingest.data?.events_last_24h ?? 0;
  if (ingest.data?.last_event != null && eventsLast24h === 0) {
    items.push({
      key: "events",
      icon: Zap,
      tone: "warning",
      title: "No events in the last 24 hours",
      description: `The last one arrived ${ago(ingest.data.last_event.received_at)}. Check that your app is still sending.`,
      linkTo: "/integrate",
      linkLabel: "Integrate",
    });
  }

  if (sending.data) {
    const { current, prior } = sending.data;
    const currentBad = current.totals.bounced + current.totals.complained;
    const priorBad = Math.max(0, prior.totals.bounced + prior.totals.complained - currentBad);
    if (currentBad >= 3 && currentBad > priorBad * 1.5) {
      items.push({
        key: "deliverability",
        icon: Shield,
        tone: "warning",
        title: `${currentBad} bounces and complaints this week`,
        description:
          priorBad > 0
            ? `Up from ${priorBad} the week before. Review content and recipient quality before the next drain.`
            : "None the week before. Review content and recipient quality before the next drain.",
        linkTo: "/analytics",
        linkLabel: "Analytics",
      });
    }
  }

  if (lifecycle.data) {
    const entered = lifecycle.data.movement.per_state.find((s) => s.state === "at_risk")?.entered ?? 0;
    if (entered >= 3) {
      items.push({
        key: "at-risk",
        icon: Activity,
        tone: "pop",
        title: `${plural(entered, "person", "people")} moved to at_risk this week`,
        description: "They stopped engaging but have not gone quiet yet. A short, personal flow works better than a blast.",
        linkTo: "/people?state=at_risk",
        linkLabel: "See who",
      });
    }
  }

  return { isLoading, items };
}

function NeedsYou({ items, isLoading }: { items: AttentionItem[]; isLoading: boolean }) {
  if (isLoading) {
    return <Skeleton className="h-[72px] w-full rounded-lg" />;
  }
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-5 py-3.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
          <Check size={13} strokeWidth={2.5} />
        </span>
        <p className="text-[14px] font-medium text-foreground">Nothing needs you</p>
        <span className="hidden text-[13px] text-muted-foreground sm:inline">
          No drafts waiting, no failures, events arriving.
        </span>
      </div>
    );
  }
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-3">
        <MicroLabel>Needs you</MicroLabel>
      </div>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <AttentionRow key={item.key} item={item} />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2. This week
// ---------------------------------------------------------------------------

function Metric({
  label,
  value,
  sub,
  subTone = "neutral",
  to,
  spark,
  sparkLabel,
  loading,
}: {
  label: string;
  value: string;
  sub?: string;
  subTone?: "neutral" | "good" | "bad";
  to: string;
  spark?: DailyPoint[];
  sparkLabel?: string;
  loading?: boolean;
}) {
  return (
    <Link
      to={to}
      className="group flex flex-col rounded-lg border border-border bg-card p-4 transition-colors duration-(--dur-fast) hover:bg-secondary sm:p-5"
    >
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{label}</p>
        <ArrowRight
          size={14}
          className="text-muted-foreground opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100"
        />
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <p className="mt-2 font-display text-[24px] font-bold leading-none tracking-[-0.02em] text-foreground sm:text-[28px]">
          {value}
        </p>
      )}
      {sub && !loading && (
        <p
          className={cn(
            "mt-1.5 font-mono text-[12px]",
            subTone === "good" ? "text-success" : subTone === "bad" ? "text-danger" : "text-muted-foreground",
          )}
        >
          {sub}
        </p>
      )}
      {spark && sparkLabel && !loading && (
        <div className="mt-auto pt-3">
          {spark.some((d) => d.count > 0) ? (
            <TrendLine rows={spark} frameLabels={false} height={32} emptyNote="" ariaLabel={sparkLabel} />
          ) : (
            <p className="flex h-8 items-center text-[12px] text-subtle-foreground">No data yet</p>
          )}
        </div>
      )}
    </Link>
  );
}

function ThisWeek() {
  const sending = useHomeSending();
  const people = useHomeNewPeople();
  const ingest = useIngestStatus(false);

  const cur = sending.data?.current.totals;
  const fortnight = sending.data?.prior;
  const prevSent = cur && fortnight ? Math.max(0, fortnight.totals.sent - cur.sent) : null;
  const sentDelta = cur && prevSent !== null ? cur.sent - prevSent : null;
  const zero = (day: string): DailyPoint => ({ day, count: 0 });
  const sentSpark = fortnight
    ? fillDays(fortnight.days.map((d) => ({ day: d.day, count: d.sent })), 14, zero)
    : undefined;
  const opensSpark = fortnight
    ? fillDays(fortnight.engagement_days.map((d) => ({ day: d.day, count: d.opens })), 14, zero)
    : undefined;

  const openValue = !cur
    ? "-"
    : cur.sent >= LOW_VOLUME_SENT
      ? `${Math.round((cur.opened / cur.sent) * 100)}%`
      : cur.opened.toLocaleString();
  const openSub = !cur
    ? undefined
    : cur.sent >= LOW_VOLUME_SENT
      ? `${cur.opened} opened, ${cur.clicked} clicked`
      : `${cur.clicked} clicked, rate shown from ${LOW_VOLUME_SENT} sends`;

  const newPeople = people.data?.total ?? people.data?.contacts.length ?? 0;

  return (
    <section>
      <MicroLabel className="mb-3">Last 7 days</MicroLabel>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Sent"
          value={(cur?.sent ?? 0).toLocaleString()}
          sub={
            sentDelta === null
              ? undefined
              : sentDelta === 0
                ? "level with the week before"
                : `${sentDelta > 0 ? "+" : ""}${sentDelta} vs the week before`
          }
          to="/sent"
          spark={sentSpark}
          sparkLabel="Messages sent per day, last 14 days"
          loading={sending.isLoading}
        />
        <Metric
          label={cur && cur.sent >= LOW_VOLUME_SENT ? "Open rate" : "Opens"}
          value={openValue}
          sub={openSub}
          to="/analytics"
          spark={opensSpark}
          sparkLabel="Opens per day, last 14 days"
          loading={sending.isLoading}
        />
        <Metric
          label="New people"
          value={newPeople.toLocaleString()}
          sub="joined this week"
          to="/people?date_field=joined&date=7d&sort=joined"
          loading={people.isLoading}
        />
        <Metric
          label="Events (24h)"
          value={(ingest.data?.events_last_24h ?? 0).toLocaleString()}
          sub={ingest.data?.last_event ? `last event ${ago(ingest.data.last_event.received_at)}` : "none received yet"}
          subTone={ingest.data?.last_event && (ingest.data.events_last_24h ?? 0) === 0 ? "bad" : "neutral"}
          to="/integrate"
          loading={ingest.isLoading}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 3a. Recent activity
// ---------------------------------------------------------------------------

interface FeedItem {
  key: string;
  at: string;
  icon: React.ElementType;
  tone: Tone | "muted";
  text: React.ReactNode;
  to: string;
}

const FEED_TONE: Record<FeedItem["tone"], string> = { ...TONE, muted: "bg-sunken text-muted-foreground" };

function feedbackWord(feedback: string | null): string | null {
  switch (feedback) {
    case "opened":
      return "opened";
    case "clicked":
      return "clicked";
    case "bounced":
      return "bounced";
    case "complained":
      return "complained";
    default:
      return null;
  }
}

function RecentActivity() {
  const sent = useHomeRecentSent();
  const people = useHomeNewPeople();
  const kb = useHomeKb();

  const isLoading = sent.isLoading || people.isLoading || kb.isLoading;
  const weekAgo = Date.now() - 7 * DAY_MS;
  const items: FeedItem[] = [];

  for (const m of sent.data?.messages ?? []) {
    if (!m.sent_at) continue;
    const fb = feedbackWord(m.feedback);
    items.push({
      key: `m:${m.id}`,
      at: m.sent_at,
      icon: Mail,
      tone: m.feedback === "bounced" || m.feedback === "complained" ? "danger" : "accent",
      text: (
        <>
          <span className="text-foreground">{m.subject || "Message"}</span>
          <span className="text-muted-foreground"> to {personLabel(m.contact)}</span>
          {fb && <span className="text-muted-foreground">, {fb}</span>}
        </>
      ),
      to: `/sent/${m.id}`,
    });
  }

  for (const c of people.data?.contacts ?? []) {
    const at = c.first_seen_at ?? c.created_at;
    items.push({
      key: `c:${c.id}`,
      at,
      icon: UserPlus,
      tone: "pop",
      text: (
        <>
          <span className="text-foreground">{personLabel(c)}</span>
          <span className="text-muted-foreground"> joined{c.company ? ` from ${c.company}` : ""}</span>
        </>
      ),
      to: `/people/${c.id}`,
    });
  }

  for (const e of kb.data?.entries ?? []) {
    if (new Date(e.updated_at).getTime() < weekAgo) continue;
    const added = Math.abs(new Date(e.updated_at).getTime() - new Date(e.created_at).getTime()) < 60_000;
    items.push({
      key: `k:${e.id}`,
      at: e.updated_at,
      icon: BookOpen,
      tone: "muted",
      text: (
        <>
          <span className="text-muted-foreground">Knowledge base: </span>
          <span className="text-foreground">{e.title}</span>
          <span className="text-muted-foreground"> {added ? "added" : "updated"}</span>
        </>
      ),
      to: `/kb/${e.id}`,
    });
  }

  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const shown = items.slice(0, 10);

  return (
    <Panel title="Recent activity" link={{ to: "/sent", label: "Sent Mail" }}>
      {isLoading ? (
        <PanelSkeleton rows={6} />
      ) : shown.length === 0 ? (
        <PanelNote>
          Nothing yet. Sent mail, people who join and knowledge base edits show up here as they happen.
        </PanelNote>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.key}>
                <Link
                  to={item.to}
                  className="flex items-center gap-3 px-5 py-2.5 transition-colors duration-(--dur-fast) hover:bg-secondary"
                >
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                      FEED_TONE[item.tone],
                    )}
                  >
                    <Icon size={13} strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{item.text}</span>
                  <span className="shrink-0 font-mono text-[12px] text-subtle-foreground">{ago(item.at)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 3b. Active flows
// ---------------------------------------------------------------------------

function ActiveFlows({ flows }: { flows: Flow[] }) {
  const sending = useHomeSending();
  const pending = useHomePendingMessages();
  const active = flows.filter((f) => f.status === "active");
  const paused = flows.filter((f) => f.status === "paused").length;
  const drafts = flows.filter((f) => f.status === "draft").length;

  const perFlow = new Map((sending.data?.current.per_flow ?? []).map((r) => [r.flow_id, r]));
  const pendingPerFlow = new Map<string, number>();
  for (const m of pending.data?.messages ?? []) {
    pendingPerFlow.set(m.flow_id, (pendingPerFlow.get(m.flow_id) ?? 0) + 1);
  }

  const rows = [...active].sort(
    (a, b) => (perFlow.get(b.id)?.sent ?? 0) - (perFlow.get(a.id)?.sent ?? 0) || a.name.localeCompare(b.name),
  );
  const others = [paused > 0 ? `${paused} paused` : null, drafts > 0 ? `${plural(drafts, "draft")}` : null]
    .filter(Boolean)
    .join(", ");

  return (
    <Panel title={`Active flows${active.length ? ` (${active.length})` : ""}`} link={{ to: "/flows", label: "Flows" }}>
      {active.length === 0 ? (
        <div className="flex flex-col items-start gap-3 px-5 py-4">
          <p className="text-[13px] leading-[20px] text-muted-foreground">
            No flow is active, so nobody is enrolled.{others ? ` You have ${others}.` : ""} Describe one in plain
            words and Claros compiles it into a plan.
          </p>
          <Link to="/flows/new" className={buttonVariants({ size: "sm" })}>
            New flow
          </Link>
        </div>
      ) : (
        <>
          <table className="w-full table-fixed text-[13px]">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  Flow
                </th>
                <th className="w-20 px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  Sent 7d
                </th>
                <th className="hidden w-20 px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground sm:table-cell">
                  Opened
                </th>
                <th className="w-24 px-5 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  Waiting
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((flow) => {
                const stats = perFlow.get(flow.id);
                const waiting = pendingPerFlow.get(flow.id) ?? 0;
                return (
                  <tr key={flow.id} className="border-b border-border last:border-0 hover:bg-secondary">
                    <td className="px-5 py-2.5">
                      <Link
                        to={`/flows/${flow.id}/edit`}
                        className="block truncate font-medium text-foreground hover:text-accent-text"
                      >
                        {flow.name}
                      </Link>
                      <p className="truncate font-mono text-[12px] text-muted-foreground">
                        {triggerLabel(flow)}
                        {flow.approval_mode === "auto" ? " · auto-approve" : ""}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[12px] text-foreground">
                      {stats?.sent ?? 0}
                    </td>
                    <td className="hidden px-3 py-2.5 text-right font-mono text-[12px] text-muted-foreground sm:table-cell">
                      {stats?.opened ?? 0}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      {waiting > 0 ? (
                        <Link to="/approvals" className="font-mono text-[12px] text-accent-text">
                          {waiting}
                        </Link>
                      ) : (
                        <span className="font-mono text-[12px] text-subtle-foreground">0</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {others && <p className="border-t border-border px-5 py-2.5 text-[12px] text-muted-foreground">Also {others}.</p>}
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 4a. Lifecycle this week
// ---------------------------------------------------------------------------

const STATE_ORDER = ["signed_up", "activated", "engaged", "at_risk", "dormant", "gone_quiet", "resurrected"];
const BAD_STATES = new Set(["at_risk", "dormant", "gone_quiet", "churned"]);

function LifecycleCard() {
  const lifecycle = useHomeLifecycle();
  const data = lifecycle.data;

  const totals = new Map<string, number>();
  const moved = new Map<string, { entered: number; exited: number }>();
  for (const r of data?.distribution ?? []) {
    const s = stateName(r.state);
    totals.set(s, (totals.get(s) ?? 0) + r.total);
  }
  for (const r of data?.movement.per_state ?? []) {
    const s = stateName(r.state);
    const prev = moved.get(s) ?? { entered: 0, exited: 0 };
    moved.set(s, { entered: prev.entered + r.entered, exited: prev.exited + r.exited });
  }
  const states = STATE_ORDER.filter((s) => (totals.get(s) ?? 0) > 0 || moved.has(s));
  const max = Math.max(1, ...states.map((s) => totals.get(s) ?? 0));

  return (
    <Panel title="Lifecycle" link={{ to: "/lifecycle", label: "Lifecycle" }}>
      {lifecycle.isLoading ? (
        <PanelSkeleton rows={5} />
      ) : !data || data.contacts_total === 0 ? (
        <PanelNote>States appear once people arrive with identify calls and events.</PanelNote>
      ) : (
        <div className="px-5 py-4">
          <p className="mb-3 text-[13px] text-muted-foreground">
            {plural(data.contacts_total, "person", "people")}, change in the last 7 days on the right.
          </p>
          <ul className="space-y-2.5">
            {states.map((s) => {
              const total = totals.get(s) ?? 0;
              const m = moved.get(s);
              const net = m ? m.entered - m.exited : 0;
              const bad = BAD_STATES.has(s);
              // Same reading as the Lifecycle page: growth in a bad state or a
              // shrinking engaged state is a problem; leaving signed_up is not news.
              const problem = net !== 0 && (bad ? net > 0 : s === "engaged" && net < 0);
              const good = net !== 0 && !problem && (bad ? net < 0 : s !== "signed_up" && net > 0);
              const tone = problem ? "text-danger" : good ? "text-success" : "text-subtle-foreground";
              return (
                <li key={s}>
                  <Link to={`/people?state=${s}`} className="group block">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-mono text-[12px] text-foreground group-hover:text-accent-text">{s}</span>
                      <span className="flex items-baseline gap-3">
                        <span className="font-mono text-[12px] text-muted-foreground">{total.toLocaleString()}</span>
                        <span className={cn("w-10 text-right font-mono text-[12px]", tone)}>
                          {net > 0 ? `+${net}` : net === 0 ? "0" : net}
                        </span>
                      </span>
                    </div>
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-sunken">
                      <div
                        className={cn("h-full rounded-full", bad ? "bg-subtle-foreground" : "bg-accent")}
                        style={{ width: `${Math.max(total > 0 ? 2 : 0, (total / max) * 100)}%` }}
                      />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 4b. Connect your AI
// ---------------------------------------------------------------------------

function ConnectAiCard({ keys, loading }: { keys: IngestKey[]; loading: boolean }) {
  const state = mcpKeyState(keys);
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text">
          <Bot size={16} strokeWidth={1.5} />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-foreground">Review from your AI assistant</p>
          <p className="mt-1 text-[13px] leading-[20px] text-muted-foreground">
            Ask Claude Code or Claude Desktop "anything waiting in Claros?" and approve, edit or reject drafts in
            the chat. Same rules as this dashboard.
          </p>
        </div>
      </div>
      {loading ? (
        <Skeleton className="mt-4 h-8 w-full" />
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          {state.kind === "used" ? (
            <Badge variant="success">Key used {ago(state.lastUsedAt)}</Badge>
          ) : state.kind === "ready" ? (
            <Badge variant="accent">Key ready, not used yet</Badge>
          ) : (
            <Badge variant="muted">Not set up</Badge>
          )}
          <Link
            to="/connect-ai"
            className={buttonVariants({
              size: "sm",
              variant: state.kind === "none" ? "default" : "secondary",
              className: "ml-auto",
            })}
          >
            {state.kind === "none" ? "Connect your AI" : "Setup and prompts"}
          </Link>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 4c. Knowledge base
// ---------------------------------------------------------------------------

function KnowledgeCard() {
  const kb = useHomeKb();
  const entries = kb.data?.entries ?? [];
  const more = kb.data?.next_cursor != null;
  const active = entries.filter((e) => e.is_active).length;
  const failed = entries.filter((e) => e.embedding_status === "failed").length;
  const latest = [...entries].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

  return (
    <Panel title="Knowledge base" link={{ to: "/kb", label: "Open" }}>
      {kb.isLoading ? (
        <PanelSkeleton rows={2} />
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-start gap-3 px-5 py-4">
          <p className="text-[13px] leading-[20px] text-muted-foreground">
            Empty. Drafts read the knowledge base at draft time: add pricing, plans and policies so they stop
            guessing.
          </p>
          <Link to="/kb/new" className={buttonVariants({ size: "sm", variant: "secondary" })}>
            Add an entry
          </Link>
        </div>
      ) : (
        <div className="px-5 py-4">
          <p className="text-[13px] text-foreground">
            <span className="font-mono">{active.toLocaleString()}{more ? "+" : ""}</span> active{" "}
            {active === 1 && !more ? "entry" : "entries"}
            {entries.length > active && (
              <span className="text-muted-foreground">, {entries.length - active} inactive</span>
            )}
          </p>
          {latest && (
            <p className="mt-1 truncate text-[13px] text-muted-foreground">
              Last change {ago(latest.updated_at)}:{" "}
              <Link to={`/kb/${latest.id}`} className="text-foreground hover:text-accent-text">
                {latest.title}
              </Link>
            </p>
          )}
          {failed > 0 && (
            <p className="mt-2 text-[13px] text-danger">
              {plural(failed, "entry", "entries")} failed to embed and cannot be retrieved.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 4d. Resources
// ---------------------------------------------------------------------------

/**
 * Short product tips, rotated daily by day of year. Curated in code: no
 * backend, no LLM. Each one is grounded in released behavior.
 */
const TIPS: string[] = [
  "Install the library Welcome flow first. It sends real email with no LLM configured, so you can check the whole pipeline end to end.",
  "Use window_policy \"immediate\" for dunning and welcome emails. Delays there cost money; newsletters can wait for the send window.",
  "Only one nurture-class flow can be active per person. Put receipts and alerts in critical-class flows so they run alongside.",
  "Set a flow's reentry_policy to \"cooldown\" when people can legitimately trigger it twice, like a trial that converts, cancels and returns.",
  "Keep auto-approve off until a flow has drafted emails you would sign your name to.",
  "The knowledge base is read at draft time. Add your pricing page and cancellation policy so drafts stop inventing answers.",
  "at_risk people stopped engaging but have not gone quiet yet. A short, personal flow beats a discount blast.",
  "Critical-class messages bypass the throttle but never fairness: one busy product cannot starve another's dunning.",
  "Lifecycle and marketing mail carries one-click unsubscribe headers automatically; transactional-topic mail does not.",
  "Rotate ingest keys without downtime: create the new key, deploy it, then revoke the old one on the Integrate page.",
  "Under Revise with AI on a draft, tell the drafter what to change in plain words instead of editing by hand.",
  "Flows compile when you save them, not when they send. Fix compile errors early: a failed flow enrolls nobody.",
];

function tipOfTheDay(): string {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / DAY_MS);
  return TIPS[dayOfYear % TIPS.length]!;
}

export function Resources() {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sunken text-muted-foreground">
          <Lightbulb size={16} strokeWidth={1.5} />
        </span>
        <div>
          <p className="text-[14px] font-medium text-foreground">Tip of the day</p>
          <p className="mt-1 text-[13px] leading-[20px] text-muted-foreground">{tipOfTheDay()}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-3">
        <a
          href="https://claros.org/docs"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-[13px] text-accent-text"
        >
          <BookOpen size={14} strokeWidth={1.5} />
          Documentation
          <ArrowUpRight size={12} />
        </a>
        <a
          href="https://github.com/claroshq/claros/discussions"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-[13px] text-accent-text"
        >
          <MessagesSquare size={14} strokeWidth={1.5} />
          Discussions
          <ArrowUpRight size={12} />
        </a>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function HomeOverview({
  flows,
  setupBanner,
}: {
  flows: Flow[];
  /** The "finish setup" banner, rendered under the header while setup is incomplete. */
  setupBanner?: React.ReactNode;
}) {
  const { isLoading, items } = useAttentionItems(flows);
  const keys = useIngestKeys();

  const subtitle = isLoading
    ? undefined
    : items.length > 0
      ? `${plural(items.length, "thing")} need${items.length === 1 ? "s" : ""} you. The rest of the week is below.`
      : "Nothing needs you. Here is what happened this week.";

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow="Overview" title="Home" subtitle={subtitle} />

      {setupBanner}

      <div className="space-y-6">
        <NeedsYou items={items} isLoading={isLoading} />
        <ThisWeek />
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <RecentActivity />
            <ActiveFlows flows={flows} />
          </div>
          <div className="space-y-6">
            <LifecycleCard />
            <ConnectAiCard keys={keys.data?.keys ?? []} loading={keys.isLoading} />
            <KnowledgeCard />
            <Resources />
          </div>
        </div>
      </div>
    </div>
  );
}
