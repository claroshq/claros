/**
 * Home page - the single landing screen with two modes.
 *
 * Before a tenant is set up: a setup path that sorts requirements honestly
 * into tiers (blocks sending, blocks AI only, requires file edit) and
 * includes the library flow installer as the fastest path to real behavior.
 *
 * After setup: an operational view answering "what needs me" - pending
 * approvals, failures, ingestion health, compile errors, and deliverability
 * signals. Every item links to where the problem is fixed.
 *
 * The two modes share a single route (/home) and transition automatically.
 * The setup path is always reachable from the operational view via a quiet
 * link if anything regresses or was skipped.
 */
import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  AlertTriangle,
  Inbox,
  XCircle,
  Activity,
  Zap,
  Mail,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  ArrowUpRight,
  Shield,
  BookOpen,
  MessagesSquare,
  Lightbulb,
} from "lucide-react";
import { PageHeader } from "../components/page-header.js";
import { Button } from "../components/ui/button.js";
import { Badge } from "../components/ui/badge.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { cn } from "../lib/utils.js";
import { useSetupState } from "../settings.js";
import { useIngestStatus, useIngestKeys } from "../ingestion.js";
import { useFlows } from "../flows.js";
import {
  useDiagnostics,
  useLibrary,
  useInstallLibrary,
  useHomePendingMessages,
  useHomeFailedMessages,
  useHomeSending,
  useHomeLifecycle,
} from "../home.js";
import type { Flow } from "../api.js";

// ---------------------------------------------------------------------------
// Setup mode
// ---------------------------------------------------------------------------

/**
 * The eight requirements sorted into honest tiers:
 *
 * TIER A - Blocks all sending (the engine is dead without these):
 *   1. ENCRYPTION_KEY (env file, cannot fix from dashboard)
 *   2. UNSUBSCRIBE_SIGNING_KEY (env file, cannot fix from dashboard)
 *   3. Transport (dashboard, Settings page)
 *   4. Postal address (dashboard, Settings page)
 *
 * TIER B - Blocks AI features only (library flows work without these):
 *   5. LLM provider (dashboard, Settings page)
 *
 * TIER C - Needed for real behavior but not blocking the engine itself:
 *   6. An active flow (dashboard, install from library or create)
 *   7. An ingest key (dashboard, Integrate page)
 *   8. First event received (requires code in the user's app)
 *
 * BASE_URL: required for unsubscribe links but set in the env file.
 * Not checkable from the API (no endpoint reports it). Omitted from the
 * checklist because showing a checkbox that can never turn green from the
 * dashboard is hostile. Documented in the "env vars" tier note instead.
 */

interface SetupCheck {
  key: string;
  done: boolean;
  label: string;
  reason: string;
  fixLocation: "env" | "settings" | "integrate" | "home" | "code";
  linkTo?: string;
  linkLabel?: string;
}

function SetupCheckItem({ check }: { check: SetupCheck }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
          check.done
            ? "border-success bg-success-soft text-success"
            : "border-border-strong",
        )}
      >
        {check.done && <Check size={12} strokeWidth={2.5} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-[14px] leading-[20px]",
              check.done ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {check.label}
          </span>
          {check.fixLocation === "env" && !check.done && (
            <span className="rounded bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              env file
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[13px] leading-[18px] text-muted-foreground">
          {check.reason}
        </p>
        {!check.done && check.linkTo && (
          <Link
            to={check.linkTo}
            className="mt-1 inline-block text-[13px] text-accent-text underline underline-offset-4"
          >
            {check.linkLabel}
          </Link>
        )}
      </div>
    </li>
  );
}

function SetupTier({
  title,
  description,
  checks,
  defaultOpen,
  prominent,
}: {
  title: string;
  description: string;
  checks: SetupCheck[];
  defaultOpen?: boolean;
  prominent?: boolean;
}) {
  const allDone = checks.every((c) => c.done);
  const doneCount = checks.filter((c) => c.done).length;
  const [open, setOpen] = useState(defaultOpen ?? !allDone);

  return (
    <div className={cn(
      "rounded-lg border bg-card",
      prominent && !allDone ? "border-border-strong" : "border-border",
    )}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset rounded-lg"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h3 className={cn(
              "text-[15px] text-foreground",
              prominent ? "font-semibold" : "font-medium",
            )}>{title}</h3>
            {allDone ? (
              <Badge variant="success">Done</Badge>
            ) : (
              <span className="text-[12px] text-muted-foreground">
                {doneCount}/{checks.length}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
        </div>
        <span className="ml-3 shrink-0 text-muted-foreground">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-5 pb-4 pt-2">
          <ul>
            {checks.map((c) => (
              <SetupCheckItem key={c.key} check={c} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library section (embedded in setup)
// ---------------------------------------------------------------------------

function LibrarySection({
  hasActiveFlow,
  hasTransport,
}: {
  hasActiveFlow: boolean;
  hasTransport: boolean;
}) {
  const library = useLibrary();
  const install = useInstallLibrary();
  const flows = useFlows();
  const [showEmails, setShowEmails] = useState(false);

  const libraryFlow = library.data?.flows[0];
  const alreadyInstalled = flows.data?.flows.some(
    (f) => f.source === "library" && f.name === "Welcome Onboarding",
  );
  const installedFlow = flows.data?.flows.find(
    (f) => f.source === "library" && f.name === "Welcome Onboarding",
  );
  const isActive = installedFlow?.status === "active";

  function handleInstall() {
    install.mutate(undefined);
  }

  if (library.isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card p-5">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-2 h-4 w-80" />
      </div>
    );
  }

  if (!libraryFlow) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Mail size={16} className="text-accent-text" />
            <h3 className="text-[15px] font-medium text-foreground">
              {libraryFlow.name}
            </h3>
            {isActive && <Badge variant="success">Active</Badge>}
            {alreadyInstalled && !isActive && <Badge variant="neutral">Installed</Badge>}
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {libraryFlow.description}
          </p>
          <p className="mt-2 text-[13px] text-muted-foreground">
            {libraryFlow.emails} emails over 3 days, triggered by a{" "}
            <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[12px]">
              {libraryFlow.trigger}
            </code>
            {" "}event. No LLM required.
          </p>
        </div>
      </div>

      {/* Email preview */}
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setShowEmails(!showEmails)}
          className="flex items-center gap-1.5 text-[13px] text-accent-text hover:underline"
        >
          {showEmails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {showEmails ? "Hide emails" : "Preview the emails"}
        </button>
        {showEmails && (
          <div className="mt-3 space-y-3">
            {libraryFlow.templates.map((t, i) => (
              <div
                key={t.slug}
                className="rounded-md border border-border bg-background p-4"
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sunken text-[11px] font-medium text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="text-[14px] font-medium text-foreground">
                    {t.name}
                  </span>
                  <span className="text-[12px] text-muted-foreground">
                    {i === 0 ? "Immediate" : i === 1 ? "After 1 day" : "After 3 days"}
                  </span>
                </div>
                <p className="mt-1.5 pl-7 text-[13px] text-muted-foreground">
                  Subject: {t.subject}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-4 flex items-center gap-3">
        {!alreadyInstalled && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleInstall}
            disabled={install.isPending}
          >
            {install.isPending ? "Installing..." : "Install flow"}
          </Button>
        )}
        {alreadyInstalled && !isActive && (
          <Link to={`/flows/${installedFlow!.id}/edit`}>
            <Button size="sm">
              Review and activate
            </Button>
          </Link>
        )}
        {isActive && !hasTransport && (
          <p className="text-[13px] text-warning">
            Flow is active but no transport is configured - emails cannot be delivered yet.
          </p>
        )}
        {isActive && hasTransport && (
          <p className="text-[13px] text-success">
            Active and ready to send when a contact fires the trigger event.
          </p>
        )}
      </div>

      {install.isError && (
        <p className="mt-3 rounded-md border border-danger bg-danger-soft px-3.5 py-2.5 text-[13px] text-foreground">
          {install.error instanceof Error ? install.error.message : "Install failed."}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operational mode - "What needs me" cards
// ---------------------------------------------------------------------------

function AttentionCard({
  icon: Icon,
  tone,
  title,
  description,
  linkTo,
  linkLabel,
  badge,
}: {
  icon: React.ElementType;
  tone: "accent" | "danger" | "warning" | "pop";
  title: string;
  description: string;
  linkTo: string;
  linkLabel: string;
  badge?: React.ReactNode;
}) {
  const toneClasses: Record<typeof tone, string> = {
    accent: "bg-accent-soft text-accent-text",
    danger: "bg-danger-soft text-danger",
    warning: "bg-warning-soft text-warning",
    pop: "bg-pop-soft text-pop-text",
  };
  return (
    <Link
      to={linkTo}
      className="group flex items-start gap-4 rounded-lg border border-border bg-card p-5 transition-colors duration-(--dur-fast) hover:bg-secondary"
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
          toneClasses[tone],
        )}
      >
        <Icon size={18} strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-[14px] font-medium text-foreground">{title}</p>
          {badge}
        </div>
        <p className="mt-1 text-[13px] leading-[20px] text-muted-foreground">{description}</p>
        <span className="mt-2 inline-flex items-center gap-1 text-[13px] text-accent-text">
          {linkLabel}
          <ArrowRight
            size={12}
            className="transition-transform duration-(--dur-fast) group-hover:translate-x-0.5"
          />
        </span>
      </div>
    </Link>
  );
}

/**
 * Setup banner - shown at the top of the operational view while any
 * requirement is unmet. Replaces the quiet header ghost button: setup is
 * the page's main verb until it is done, so it gets the primary fill.
 */
function SetupBanner({
  doneCount,
  totalCount,
  onShowSetup,
}: {
  doneCount: number;
  totalCount: number;
  onShowSetup: () => void;
}) {
  const pct = Math.round((doneCount / totalCount) * 100);
  return (
    <div className="mb-6 flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium text-foreground">Finish setup</p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {doneCount} of {totalCount} requirements met. The remaining items
          unlock everything this install can do.
        </p>
        <div
          role="progressbar"
          aria-valuenow={doneCount}
          aria-valuemin={0}
          aria-valuemax={totalCount}
          aria-label="Setup progress"
          className="mt-3 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-sunken"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-(--dur-med)"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <Button className="shrink-0" onClick={onShowSetup}>
        Finish setup
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resources section - docs, community, rotating tip
// ---------------------------------------------------------------------------

/**
 * Short product tips, rotated daily by day-of-year. Curated in code: no
 * backend, no LLM, always available offline. Keep each tip to one or two
 * sentences and ground it in a real product behavior.
 */
const TIPS: string[] = [
  "Install the library Welcome flow first. It sends real email with no LLM configured, so you can verify the whole pipeline end to end.",
  "Use window_policy \"immediate\" for dunning and welcome emails. Delays there cost money; newsletters can wait for the send window.",
  "Only one nurture-class flow can be active per contact. Splitting onboarding into nurture and critical classes keeps receipts and alerts flowing in parallel.",
  "Set a flow's reentry_policy to \"cooldown\" when contacts can legitimately trigger it twice, like a trial that converts then churns and returns.",
  "Approvals are the trust layer. Keep auto-approve off until a flow has drafted emails you would sign your name to.",
  "The Knowledge Base is read at draft time. Add your pricing page and cancellation policy so drafts stop inventing answers.",
  "At-risk contacts stopped engaging but have not churned. A short, personal re-engagement flow beats a discount blast.",
  "Critical-class messages bypass the throttle but never fairness. A big tenant cannot starve a small tenant's dunning emails.",
  "Every outgoing email carries List-Unsubscribe headers automatically. Never remove the footer; the drain refuses to send without it.",
  "Rotate ingest keys without downtime: create the new key, deploy it, then revoke the old one from the Integrate page.",
  "Bounces and complaints compound. If this week's count rises above last week's, pause and review content before the next drain cycle.",
  "Flow compile happens at save time, not send time. Fix compile errors early; a failed flow silently stops enrolling contacts.",
];

function tipOfTheDay(): string {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
  return TIPS[dayOfYear % TIPS.length]!;
}

function ResourceCard({
  icon: Icon,
  title,
  description,
  href,
  linkLabel,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group rounded-lg border border-border bg-card p-5 transition-colors duration-(--dur-fast) hover:bg-secondary"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent-soft text-accent-text">
        <Icon size={18} strokeWidth={1.5} />
      </span>
      <p className="mt-3 text-[14px] font-medium text-foreground">{title}</p>
      <p className="mt-1 text-[13px] leading-[20px] text-muted-foreground">
        {description}
      </p>
      <span className="mt-2 inline-flex items-center gap-1 text-[13px] text-accent-text">
        {linkLabel}
        <ArrowUpRight
          size={12}
          className="transition-transform duration-(--dur-fast) group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
        />
      </span>
    </a>
  );
}

/**
 * The bottom band of the home screen: pointers out of the product to the
 * documentation and the community, plus a rotating tip. Renders in every
 * mode so the page never ends in dead space.
 */
function ResourcesSection() {
  return (
    <div className="mt-8">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        Resources
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <ResourceCard
          icon={BookOpen}
          title="Documentation"
          description="Setup guides, the flow model, ingestion API reference, and self-hosting notes."
          href="https://claros.org/docs"
          linkLabel="claros.org/docs"
        />
        <ResourceCard
          icon={MessagesSquare}
          title="Ask the community"
          description="Questions, flow recipes, and deliverability war stories from other Claros operators."
          href="https://claros.org/community"
          linkLabel="claros.org/community"
        />
        <div className="rounded-lg border border-border bg-card p-5 sm:col-span-2 lg:col-span-1">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent-soft text-accent-text">
            <Lightbulb size={18} strokeWidth={1.5} />
          </span>
          <p className="mt-3 text-[14px] font-medium text-foreground">
            Tip of the day
          </p>
          <p className="mt-1 text-[13px] leading-[20px] text-muted-foreground">
            {tipOfTheDay()}
          </p>
        </div>
      </div>
    </div>
  );
}

function OperationalHome({
  flows,
  onShowSetup,
  setupIncomplete,
  setupDoneCount,
  setupTotalCount,
}: {
  flows: Flow[];
  onShowSetup: () => void;
  setupIncomplete: boolean;
  setupDoneCount: number;
  setupTotalCount: number;
}) {
  const pending = useHomePendingMessages();
  const failed = useHomeFailedMessages();
  const ingest = useIngestStatus(false);
  const sending = useHomeSending();
  const lifecycle = useHomeLifecycle();

  // Loading state - show skeleton before computing items
  const isLoading = pending.isLoading || failed.isLoading || ingest.isLoading;
  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Home" />
        <div className="space-y-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  // Compute attention items
  const items: React.ReactNode[] = [];

  // 1. Messages waiting for approval
  const pendingCount = pending.data?.messages.length ?? 0;
  if (pendingCount > 0) {
    items.push(
      <AttentionCard
        key="pending"
        icon={Inbox}
        tone="accent"
        title={`${pendingCount} message${pendingCount === 1 ? "" : "s"} waiting for approval`}
        description="Review and approve to send, or reject to discard."
        linkTo="/approvals"
        linkLabel="Approvals"
        badge={<Badge variant="accent">{pendingCount}</Badge>}
      />,
    );
  }

  // 2. Failed messages
  const failedCount = failed.data?.messages.length ?? 0;
  if (failedCount > 0) {
    const reasons = failed.data!.messages.slice(0, 3).map((m) => m.brain_reasoning).filter(Boolean);
    const topReason = reasons[0] ?? "Check the Approvals page for details.";
    items.push(
      <AttentionCard
        key="failed"
        icon={XCircle}
        tone="danger"
        title={`${failedCount} message${failedCount === 1 ? "" : "s"} failed`}
        description={topReason}
        linkTo="/approvals"
        linkLabel="Approvals"
        badge={<Badge variant="danger">{failedCount}</Badge>}
      />,
    );
  }

  // 3. Flows with compile errors
  const compileErrors = flows.filter((f) => f.compile_status === "failed" && f.status !== "archived");
  if (compileErrors.length > 0) {
    items.push(
      <AttentionCard
        key="compile-errors"
        icon={AlertTriangle}
        tone="warning"
        title={`${compileErrors.length} flow${compileErrors.length === 1 ? "" : "s"} failed to compile`}
        description={compileErrors[0]!.compile_error ?? `"${compileErrors[0]!.name}" needs attention.`}
        linkTo={`/flows/${compileErrors[0]!.id}/edit`}
        linkLabel="Flow editor"
      />,
    );
  }

  // 4. Events stopped arriving
  const hasEventsHistorically = ingest.data?.last_event != null;
  const eventsLast24h = ingest.data?.events_last_24h ?? 0;
  if (hasEventsHistorically && eventsLast24h === 0) {
    items.push(
      <AttentionCard
        key="events-stopped"
        icon={Zap}
        tone="warning"
        title="No events received in the last 24 hours"
        description="Events were arriving before. Check your integration or confirm the source is still sending."
        linkTo="/integrate"
        linkLabel="Integrate"
      />,
    );
  }

  // 5. Bounces or complaints rising (compare current 7d vs prior 7d)
  if (sending.data) {
    const { current, prior } = sending.data;
    const currentBad = current.totals.bounced + current.totals.complained;
    const priorBad = (prior.totals.bounced + prior.totals.complained) - currentBad;
    // prior contains 14 days total; the "prior 7d" is the difference
    const priorPeriodBad = Math.max(0, priorBad);
    if (currentBad > 0 && currentBad > priorPeriodBad * 1.5 && currentBad >= 3) {
      items.push(
        <AttentionCard
          key="deliverability"
          icon={Shield}
          tone="warning"
          title={`${currentBad} bounce${currentBad === 1 ? "" : "s"}/complaint${currentBad === 1 ? "" : "s"} this week`}
          description={
            priorPeriodBad > 0
              ? `Up from ${priorPeriodBad} in the prior 7 days. Review sending patterns.`
              : "New this week. Check email content and recipient quality."
          }
          linkTo="/analytics"
          linkLabel="Analytics"
        />,
      );
    }
  }

  // 6. Contacts moving to at_risk (lifecycle movement)
  if (lifecycle.data) {
    const atRiskEntry = lifecycle.data.movement.per_state.find((s) => s.state === "at_risk");
    const entered = atRiskEntry?.entered ?? 0;
    if (entered >= 3) {
      items.push(
        <AttentionCard
          key="at-risk"
          icon={Activity}
          tone="pop"
          title={`${entered} contact${entered === 1 ? "" : "s"} moved to at-risk this week`}
          description="These contacts have stopped engaging. Consider reaching out before they go dormant."
          linkTo="/lifecycle"
          linkLabel="Lifecycle"
        />,
      );
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Overview"
        title="Home"
        subtitle={
          items.length > 0
            ? `${items.length} thing${items.length === 1 ? "" : "s"} need${items.length === 1 ? "s" : ""} attention`
            : undefined
        }
      />

      {setupIncomplete && (
        <SetupBanner
          doneCount={setupDoneCount}
          totalCount={setupTotalCount}
          onShowSetup={onShowSetup}
        />
      )}

      {items.length > 0 ? (
        <div className="space-y-3">{items}</div>
      ) : (
        <AllClearState flows={flows} eventsLast24h={eventsLast24h} sending={sending.data} />
      )}

      <ResourcesSection />
    </div>
  );
}

/**
 * The healthy install state. Nothing is wrong - but the page must not feel
 * empty. Show a factual status snapshot: the three numbers that tell you the
 * system is alive, plus the active flow list so there is something to read.
 */
function AllClearState({
  flows,
  eventsLast24h,
  sending,
}: {
  flows: Flow[];
  eventsLast24h: number;
  sending: { current: { totals: { sent: number; opened: number } } } | undefined;
}) {
  const activeFlows = flows.filter((f) => f.status === "active");
  const activeCount = activeFlows.length;
  const sentThisWeek = sending?.current.totals.sent ?? 0;

  return (
    <div className="space-y-4">
      {/* Status banner */}
      <div className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
            <Check size={14} strokeWidth={2.5} />
          </span>
          <p className="text-[14px] font-medium text-foreground">
            Nothing needs attention
          </p>
          <span className="text-[13px] text-muted-foreground sm:ml-auto">
            All systems operating normally.
          </span>
        </div>
      </div>

      {/* Three-metric snapshot */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatusMetric
          label="Active flows"
          value={activeCount}
          linkTo="/flows"
        />
        <StatusMetric
          label="Events (24h)"
          value={eventsLast24h}
          linkTo="/integrate"
        />
        <StatusMetric
          label="Sent (7d)"
          value={sentThisWeek}
          linkTo="/analytics"
        />
      </div>

      {/* Active flow list - gives the page something concrete to read */}
      {activeFlows.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              Active flows
            </p>
          </div>
          <ul>
            {activeFlows.map((flow, i) => (
              <li
                key={flow.id}
                className={cn(
                  "flex items-center justify-between px-5 py-3",
                  i < activeFlows.length - 1 && "border-b border-border",
                )}
              >
                <div>
                  <Link
                    to={`/flows/${flow.id}/edit`}
                    className="text-[14px] font-medium text-foreground hover:text-accent-text"
                  >
                    {flow.name}
                  </Link>
                  <p className="mt-0.5 text-[12px] font-mono text-muted-foreground">
                    {flow.trigger_type === "event"
                      ? `on ${String((flow.trigger_config as Record<string, unknown>).event ?? "event")}`
                      : flow.trigger_type.replace(/_/g, " ")}
                  </p>
                </div>
                <Badge variant="success">Active</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatusMetric({
  label,
  value,
  linkTo,
}: {
  label: string;
  value: number;
  linkTo: string;
}) {
  return (
    <Link
      to={linkTo}
      className="group rounded-lg border border-border bg-card px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-secondary sm:px-5 sm:py-4"
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground sm:text-[12px]">
        {label}
      </p>
      <div className="mt-2 flex items-end justify-between">
        <p className="font-display text-[22px] font-bold leading-none tracking-[-0.02em] text-foreground sm:text-[28px]">
          {value.toLocaleString()}
        </p>
        <ArrowRight
          size={14}
          className="mb-0.5 text-muted-foreground opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100"
        />
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Setup mode
// ---------------------------------------------------------------------------

function SetupHome({
  onSkip,
  checks,
}: {
  onSkip: () => void;
  checks: {
    encryptionKey: boolean;
    signingKey: boolean;
    transport: boolean;
    postalAddress: boolean;
    llm: boolean;
    activeFlow: boolean;
    ingestKey: boolean;
    firstEvent: boolean;
    hasTransport: boolean;
  };
}) {
  const tierA: SetupCheck[] = [
    {
      key: "encryption",
      done: checks.encryptionKey,
      label: "ENCRYPTION_KEY environment variable",
      reason: "Encrypts transport credentials at rest. Without it the server cannot store or read API keys.",
      fixLocation: "env",
    },
    {
      key: "signing",
      done: checks.signingKey,
      label: "UNSUBSCRIBE_SIGNING_KEY environment variable",
      reason: "Signs unsubscribe tokens. Without it every email would violate RFC 8058.",
      fixLocation: "env",
    },
    {
      key: "transport",
      done: checks.transport,
      label: "Email transport (Resend, SES, SMTP)",
      reason: "The service that delivers approved emails to recipients.",
      fixLocation: "settings",
      linkTo: "/settings/transport",
      linkLabel: "Configure in Settings",
    },
    {
      key: "postal",
      done: checks.postalAddress,
      label: "Postal address",
      reason: "Required by CAN-SPAM in every email footer. The drain refuses to send without it.",
      fixLocation: "settings",
      linkTo: "/settings/postal",
      linkLabel: "Set in Settings",
    },
  ];

  const tierB: SetupCheck[] = [
    {
      key: "llm",
      done: checks.llm,
      label: "LLM provider (OpenAI, Anthropic, or compatible)",
      reason: "Compiles prompt-defined flows and drafts personalized emails. Library flows work without this.",
      fixLocation: "settings",
      linkTo: "/settings/llm",
      linkLabel: "Configure in Settings",
    },
  ];

  const tierC: SetupCheck[] = [
    {
      key: "flow",
      done: checks.activeFlow,
      label: "At least one active flow",
      reason: "Flows define what emails get sent and when. Install one from the library below, or write your own.",
      fixLocation: "home",
      linkTo: "/flows",
      linkLabel: "Go to Flows",
    },
    {
      key: "ingest-key",
      done: checks.ingestKey,
      label: "Ingest API key",
      reason: "Your app uses this key to send events to Claros. No key means no data.",
      fixLocation: "integrate",
      linkTo: "/integrate",
      linkLabel: "Create in Integrate",
    },
    {
      key: "event",
      done: checks.firstEvent,
      label: "First event received",
      reason: "Proves the integration is working. Events trigger flows and create contacts.",
      fixLocation: "code",
      linkTo: "/integrate",
      linkLabel: "Integration guide",
    },
  ];

  const allChecks = [...tierA, ...tierB, ...tierC];
  const doneCount = allChecks.filter((c) => c.done).length;
  const totalCount = allChecks.length;
  const allDone = doneCount === totalCount;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Home"
        subtitle={
          allDone
            ? "Setup complete. Your install is ready to send lifecycle email."
            : `${doneCount} of ${totalCount} requirements met. Complete the remaining items to unlock sending.`
        }
        actions={
          <Button variant="ghost" size="sm" onClick={onSkip}>
            Skip setup
          </Button>
        }
      />

      {/* Env-file note: inline and quiet, not a full-width banner */}
      {(!checks.encryptionKey || !checks.signingKey) && (
        <div className="mb-5 flex items-start gap-2.5 rounded-md border border-warning bg-warning-soft px-4 py-3">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <p className="text-[13px] text-foreground">
            Some items require environment variables set before the container
            starts and cannot be changed from the dashboard. Edit your{" "}
            <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[12px]">.env</code>
            {" "}file or Docker Compose config and restart.
          </p>
        </div>
      )}

      <div className="space-y-4">
        <SetupTier
          title="Required for sending"
          description="Without these four, the engine cannot deliver a single email."
          checks={tierA}
          defaultOpen
          prominent
        />

        <SetupTier
          title="Required for AI features"
          description="Library flows work without an LLM. Add one when you want prompt-defined flows or personalized drafts."
          checks={tierB}
        />

        <SetupTier
          title="Ready to go"
          description="A flow to run, a key to receive events, and a first event to prove it works."
          checks={tierC}
          defaultOpen
        />

        {/* Library section - the fastest path to real behavior */}
        <div className="pt-2">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Fastest path to a working install
          </h2>
          <LibrarySection
            hasActiveFlow={checks.activeFlow}
            hasTransport={checks.transport}
          />
        </div>
      </div>

      <ResourcesSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component - mode switch
// ---------------------------------------------------------------------------

/**
 * Dismissed state: stored in localStorage so it persists across refreshes.
 * A user who knows what they are doing should never be blocked by setup.
 */
const SETUP_DISMISSED_KEY = "claros-home-setup-dismissed";

function readSetupDismissed(): boolean {
  try {
    return localStorage.getItem(SETUP_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSetupDismissed(v: boolean) {
  try {
    if (v) localStorage.setItem(SETUP_DISMISSED_KEY, "1");
    else localStorage.removeItem(SETUP_DISMISSED_KEY);
  } catch {
    // storage unavailable
  }
}

export default function HomePage() {
  const setup = useSetupState();
  const diagnostics = useDiagnostics();
  const ingest = useIngestStatus(false);
  const ingestKeys = useIngestKeys();
  const flows = useFlows();
  const [dismissed, setDismissed] = useState(readSetupDismissed);
  const [forceSetup, setForceSetup] = useState(false);

  // Loading state
  if (setup.isLoading || diagnostics.isLoading || ingest.isLoading || flows.isLoading || ingestKeys.isLoading) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Home" />
        <div className="space-y-4">
          <Skeleton className="h-32 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  // Compute all checks
  const encryptionKey = diagnostics.data?.keys.ENCRYPTION_KEY.present ?? false;
  const signingKey = diagnostics.data?.keys.UNSUBSCRIBE_SIGNING_KEY.present ?? false;
  const transport = setup.checks.transport;
  const postalAddress = setup.checks.postalAddress;
  const llm = setup.checks.llm;
  const activeFlow = (flows.data?.flows ?? []).some((f) => f.status === "active");
  const hasNonRevokedKey = (ingestKeys.data?.keys ?? []).some((k) => k.revoked_at === null);
  const firstEvent = ingest.data?.last_event != null;

  const checks = {
    encryptionKey,
    signingKey,
    transport,
    postalAddress,
    llm,
    activeFlow,
    ingestKey: hasNonRevokedKey,
    firstEvent,
    hasTransport: transport,
  };

  // The install is "set up" when it can actually send:
  // encryption + signing + transport + postal + at least one active flow + events arriving
  const canSend = encryptionKey && signingKey && transport && postalAddress && activeFlow && firstEvent;

  // Show setup mode if:
  // - The install cannot send AND the user has not dismissed setup, OR
  // - The user explicitly asked to see setup (forceSetup)
  const showSetup = forceSetup || (!canSend && !dismissed);

  if (showSetup) {
    return (
      <SetupHome
        checks={checks}
        onSkip={() => {
          setForceSetup(false);
          if (!canSend) {
            // User wants to skip setup even though it is incomplete.
            // Persist the dismissal so they land on operational view next time.
            setDismissed(true);
            writeSetupDismissed(true);
          }
        }}
      />
    );
  }

  // Operational mode. Show the setup banner while anything is incomplete.
  const setupTotalCount = 8;
  const setupDoneCount = [
    encryptionKey,
    signingKey,
    transport,
    postalAddress,
    llm,
    activeFlow,
    hasNonRevokedKey,
    firstEvent,
  ].filter(Boolean).length;

  return (
    <OperationalHome
      flows={flows.data?.flows ?? []}
      onShowSetup={() => {
        setForceSetup(true);
        // Clear dismissal so setup shows naturally until complete
        setDismissed(false);
        writeSetupDismissed(false);
      }}
      setupIncomplete={!canSend || !llm}
      setupDoneCount={setupDoneCount}
      setupTotalCount={setupTotalCount}
    />
  );
}
