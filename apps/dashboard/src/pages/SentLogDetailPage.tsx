/**
 * Sent-mail log detail page.
 *
 * Shows a single message: the envelope (who, when, which flow), the event
 * timeline (what happened after send), and the content as it was sent.
 *
 * Content preview: the body_html is rendered inside a sandboxed iframe with
 * scripts disabled (sandbox="") to prevent injected JS from accessing the
 * dashboard DOM. The referrerPolicy is set to no-referrer to avoid leaking
 * the dashboard URL to image hosts or link targets.
 *
 * The timeline uses the message_events table. For messages sent before the
 * event table existed, only the high-water feedback value is shown - we do
 * not fabricate a timeline from a single value.
 */
import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  Send,
  CheckCircle2,
  Eye,
  MousePointerClick,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import { PageHeader } from "../components/page-header.js";
import { Badge, type BadgeVariant } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { useSentLogDetail } from "../sent-log.js";
import type { MessageEvent } from "../api.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusVariant(status: string): BadgeVariant {
  switch (status) {
    case "sent":
      return "success";
    case "sending":
      return "warning";
    case "failed":
      return "danger";
    case "suppressed":
      return "muted";
    default:
      return "neutral";
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const EVENT_ICONS: Record<string, React.ElementType> = {
  delivered: CheckCircle2,
  opened: Eye,
  clicked: MousePointerClick,
  bounced: XCircle,
  complained: AlertTriangle,
};

const EVENT_LABELS: Record<string, string> = {
  delivered: "Delivered",
  opened: "Opened",
  clicked: "Clicked",
  bounced: "Bounced",
  complained: "Complained",
};

function eventVariant(type: string): BadgeVariant {
  switch (type) {
    case "delivered":
      return "success";
    case "opened":
      return "accent";
    case "clicked":
      return "success";
    case "bounced":
      return "danger";
    case "complained":
      return "danger";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SentLogDetailPage() {
  const { id } = useParams<{ id: string }>();
  const detail = useSentLogDetail(id ?? "");

  if (detail.isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="mb-6">
          <Skeleton className="h-5 w-32" />
        </div>
        <Skeleton className="h-8 w-64 mb-4" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <div className="mx-auto max-w-4xl">
        <Link
          to="/sent"
          className="mb-4 inline-flex items-center gap-1.5 text-[14px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> Back to Sent Mail
        </Link>
        <div className="rounded-md border border-danger bg-danger-soft px-4 py-3" role="alert">
          <p className="text-[15px] text-foreground">
            Message not found or failed to load.
          </p>
        </div>
      </div>
    );
  }

  const { message: msg, events } = detail.data;

  return (
    <div className="mx-auto max-w-4xl">
      {/* Back link */}
      <Link
        to="/sent"
        className="mb-4 inline-flex items-center gap-1.5 text-[14px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} /> Back to Sent Mail
      </Link>

      <PageHeader
        eyebrow="Message Detail"
        title={msg.subject ?? "(no subject)"}
      />

      {/* Envelope */}
      <div className="mb-8 grid grid-cols-2 gap-x-8 gap-y-3 rounded-lg border border-border bg-card p-5">
        <EnvelopeField label="To" value={msg.recipient_address ?? msg.contact.email ?? "-"} />
        <EnvelopeField label="Contact" value={msg.contact.name ?? msg.contact.external_id ?? "-"} />
        <EnvelopeField label="Flow" value={msg.flow_name ?? "-"} link={`/flows/${msg.flow_id}/edit`} />
        <EnvelopeField label="Step" value={msg.flow_step_order !== null ? `#${msg.flow_step_order}` : "-"} />
        <EnvelopeField label="Sent" value={formatDateTime(msg.sent_at)} />
        <EnvelopeField label="Created" value={formatDateTime(msg.created_at)} />
        <div className="flex items-center gap-3">
          <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Status
          </span>
          <Badge variant={statusVariant(msg.status)}>{msg.status}</Badge>
          {msg.feedback && (
            <Badge variant={eventVariant(msg.feedback)}>{msg.feedback}</Badge>
          )}
        </div>
        {msg.retry_count > 0 && (
          <EnvelopeField label="Retries" value={String(msg.retry_count)} />
        )}
      </div>

      {/* Brain reasoning (for AI-drafted messages) */}
      {msg.brain_reasoning && (
        <details className="mb-6">
          <summary className="cursor-pointer select-none text-[13px] font-medium text-muted-foreground hover:text-foreground">
            Brain reasoning
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-4 font-mono text-[12px] text-muted-foreground">
            {msg.brain_reasoning}
          </pre>
        </details>
      )}

      {/* Event Timeline */}
      <section className="mb-8">
        <h2 className="mb-4 text-[14px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Timeline
        </h2>
        {events.length === 0 ? (
          <p className="text-[13px] text-subtle-foreground">
            {msg.feedback
              ? `Highest engagement: ${msg.feedback} (no event-level timestamps available for this message).`
              : "No delivery events recorded. The transport may not report events, or the message was sent before event logging was enabled."}
          </p>
        ) : (
          <ol className="relative space-y-0">
            {events.map((event, idx) => (
              <TimelineEvent
                key={event.id}
                event={event}
                last={idx === events.length - 1}
              />
            ))}
          </ol>
        )}
      </section>

      {/* Content: tabbed view */}
      <ContentTabs
        bodyHtml={msg.body_html}
        bodyText={msg.body_text}
      />

      {/* Link to Approvals if message was pending */}
      {msg.status === "failed" && (
        <div className="mt-6 rounded-md border border-warning bg-warning-soft px-4 py-3" role="alert">
          <p className="text-[14px] text-foreground">
            This message failed.{" "}
            {msg.brain_reasoning && (
              <span>Reason: {msg.brain_reasoning}. </span>
            )}
            <Link
              to="/approvals"
              className="text-accent-text underline underline-offset-4"
            >
              View Approvals
            </Link>{" "}
            for retry options.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EnvelopeField({
  label,
  value,
  link,
}: {
  label: string;
  value: string;
  link?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
      {link ? (
        <Link
          to={link}
          className="truncate font-mono text-[13px] text-accent-text underline underline-offset-4"
        >
          {value}
        </Link>
      ) : (
        <span className="truncate font-mono text-[13px] text-foreground">{value}</span>
      )}
    </div>
  );
}

function TimelineEvent({ event, last }: { event: MessageEvent; last: boolean }) {
  const Icon = EVENT_ICONS[event.event_type] ?? Send;
  const label = EVENT_LABELS[event.event_type] ?? event.event_type;

  // Tint the node by event semantics: delivered/clicked read as healthy,
  // opened as the accent, bounces and complaints as broken.
  const toneClasses: Record<string, string> = {
    delivered: "border-transparent bg-success-soft text-success",
    opened: "border-transparent bg-accent-soft text-accent-text",
    clicked: "border-transparent bg-success-soft text-success",
    bounced: "border-transparent bg-danger-soft text-danger",
    complained: "border-transparent bg-danger-soft text-danger",
  };
  const tone = toneClasses[event.event_type] ?? "border-border-strong bg-background text-muted-foreground";

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
        className={`z-10 mt-1 flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-full border ${tone}`}
      >
        <Icon size={12} strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-[14px] text-foreground">
          <Badge variant={eventVariant(event.event_type)} className="mr-2">
            {label}
          </Badge>
          {event.metadata && typeof (event.metadata as Record<string, unknown>).url === "string" ? (
            <span className="font-mono text-[12px] text-muted-foreground">
              {(event.metadata as Record<string, string>).url}
            </span>
          ) : null}
          {event.metadata && typeof (event.metadata as Record<string, unknown>).bounce_type === "string" ? (
            <span className="font-mono text-[12px] text-muted-foreground">
              {(event.metadata as Record<string, string>).bounce_type}
              {typeof (event.metadata as Record<string, unknown>).bounce_message === "string"
                ? ` - ${(event.metadata as Record<string, string>).bounce_message}`
                : null}
            </span>
          ) : null}
        </p>
        <p className="mt-1 font-mono text-[12px] text-subtle-foreground">
          {formatDateTime(event.occurred_at)}
        </p>
      </div>
    </li>
  );
}

function ContentTabs({
  bodyHtml,
  bodyText,
}: {
  bodyHtml: string | null;
  bodyText: string | null;
}) {
  const [tab, setTab] = useState<"preview" | "text" | "html">("preview");

  if (!bodyHtml && !bodyText) {
    return (
      <p className="text-[13px] text-subtle-foreground">
        No content available (message may have been suppressed or skipped before content generation).
      </p>
    );
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-1 border-b border-border">
        {bodyHtml && (
          <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>
            Preview
          </TabButton>
        )}
        {bodyText && (
          <TabButton active={tab === "text"} onClick={() => setTab("text")}>
            Plain Text
          </TabButton>
        )}
        {bodyHtml && (
          <TabButton active={tab === "html"} onClick={() => setTab("html")}>
            HTML Source
          </TabButton>
        )}
      </div>

      {tab === "preview" && bodyHtml && (
        <iframe
          sandbox=""
          referrerPolicy="no-referrer"
          title="Message preview"
          srcDoc={bodyHtml}
          className="h-[500px] w-full rounded-md border border-border bg-white"
        />
      )}
      {tab === "text" && bodyText && (
        <pre className="max-h-[500px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-card p-4 font-mono text-[13px] text-foreground">
          {bodyText}
        </pre>
      )}
      {tab === "html" && bodyHtml && (
        <pre className="max-h-[500px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-card p-4 font-mono text-[12px] text-muted-foreground">
          {bodyHtml}
        </pre>
      )}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 pb-2 pt-1 text-[13px] font-medium transition-colors duration-150 ${
        active
          ? "border-b-2 border-foreground text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
