/**
 * Sent-mail log detail page.
 *
 * The mail comes first, as the recipient's client showed it: the body inside
 * the email template (brand, eyebrow, preheader, footer), rendered by the
 * server the same way the drain wraps it at send time (preview_html). The
 * side column holds the envelope, the event timeline, where the content came
 * from, and the AI reasoning.
 *
 * Preview isolation: the HTML renders in a sandboxed iframe without
 * allow-scripts, so nothing in it runs. allow-same-origin is granted only so
 * the page can read the document's height and show the whole mail without a
 * second scrollbar; with scripts off the frame cannot act on that origin.
 * referrerPolicy no-referrer keeps the dashboard URL from image hosts.
 *
 * The template and brand are their current versions and the unsubscribe
 * link is a placeholder, so the page says so under the preview. Opened from
 * a person's timeline, the back link returns to that person.
 *
 * The timeline uses the message_events table. For messages sent before the
 * event table existed, only the high-water feedback value is shown - we do
 * not fabricate a timeline from a single value.
 */
import { useCallback, useRef, useState } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
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
  const location = useLocation();
  const fromPerson = (location.state as { fromPerson?: string } | null)?.fromPerson ?? null;
  const back = fromPerson
    ? { to: `/people/${fromPerson}`, label: "Back to person" }
    : { to: "/sent", label: "Back to Sent Mail" };

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
          to={back.to}
          className="mb-4 inline-flex items-center gap-1.5 text-[15px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={14} /> {back.label}
        </Link>
        <div className="rounded-md border border-danger bg-danger-soft px-4 py-3" role="alert">
          <p className="text-[16px] text-foreground">
            Message not found or failed to load.
          </p>
        </div>
      </div>
    );
  }

  const { message: msg, events } = detail.data;
  const contactLabel = msg.contact.name ?? msg.contact.email ?? msg.contact.external_id ?? "Person";

  return (
    <div className="mx-auto max-w-6xl">
      <Link
        to={back.to}
        className="mb-4 inline-flex items-center gap-1.5 text-[15px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} /> {back.label}
      </Link>

      <PageHeader
        eyebrow="Sent mail"
        title={msg.subject ?? "(no subject)"}
        actions={
          <>
            <Badge variant={statusVariant(msg.status)}>{msg.status}</Badge>
            {msg.feedback && <Badge variant={eventVariant(msg.feedback)}>{msg.feedback}</Badge>}
          </>
        }
      />

      {msg.status === "failed" && (
        <div className="mb-6 rounded-md border border-warning bg-warning-soft px-4 py-3" role="alert">
          <p className="text-[15px] text-foreground">
            This message failed.{" "}
            <Link to="/approvals" className="text-accent-text underline underline-offset-4">
              View Approvals
            </Link>{" "}
            for retry options.
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <MailView
          subject={msg.subject}
          to={msg.recipient_address ?? msg.contact.email}
          date={msg.sent_at ?? msg.created_at}
          preheader={msg.preheader}
          previewHtml={msg.preview_html}
          bodyText={msg.body_text}
        />

        <aside className="space-y-6">
          <SideSection title="Details">
            <dl className="space-y-2.5 text-[14px]">
              <DetailRow label="To">
                <span className="break-all font-mono">{msg.recipient_address ?? msg.contact.email ?? "-"}</span>
              </DetailRow>
              <DetailRow label="Person">
                <Link to={`/people/${msg.contact_id}`} className="text-accent-text underline underline-offset-4">
                  {contactLabel}
                </Link>
              </DetailRow>
              <DetailRow label="Flow">
                <Link to={`/flows/${msg.flow_id}/edit`} className="text-accent-text underline underline-offset-4">
                  {msg.flow_name ?? "Flow"}
                  {msg.flow_step_order !== null ? `, step ${msg.flow_step_order}` : ""}
                </Link>
              </DetailRow>
              <DetailRow label="Content">
                {msg.template_ref ? (
                  <Link
                    to={`/flows/${msg.flow_id}/edit?template=${encodeURIComponent(msg.template_ref)}`}
                    className="font-mono text-accent-text underline underline-offset-4"
                  >
                    {msg.template_ref}
                  </Link>
                ) : (
                  <span className="text-foreground">
                    {msg.brain_action_type ? "Drafted by AI for this person" : "-"}
                  </span>
                )}
              </DetailRow>
              <DetailRow label="Created">{formatDateTime(msg.created_at)}</DetailRow>
              <DetailRow label="Sent">{formatDateTime(msg.sent_at)}</DetailRow>
              {msg.retry_count > 0 && <DetailRow label="Retries">{String(msg.retry_count)}</DetailRow>}
            </dl>
          </SideSection>

          <SideSection title="Timeline">
            {events.length === 0 ? (
              <p className="text-[14px] text-subtle-foreground">
                {msg.feedback
                  ? `Highest engagement: ${msg.feedback} (no event-level timestamps available for this message).`
                  : "No delivery events recorded. The transport may not report events, or the message was sent before event logging was enabled."}
              </p>
            ) : (
              <ol className="relative space-y-0">
                {events.map((event, idx) => (
                  <TimelineEvent key={event.id} event={event} last={idx === events.length - 1} />
                ))}
              </ol>
            )}
          </SideSection>

          {msg.brain_reasoning && (
            <SideSection title="Why this mail">
              <p className="max-h-60 overflow-auto whitespace-pre-wrap text-[14px] leading-[22px] text-muted-foreground">
                {msg.brain_reasoning}
              </p>
            </SideSection>
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SideSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card shadow-card p-5">
      <h2 className="mb-3 text-[16px] font-semibold leading-6 text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
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
        <p className="text-[15px] text-foreground">
          <Badge variant={eventVariant(event.event_type)} className="mr-2">
            {label}
          </Badge>
          {event.metadata && typeof (event.metadata as Record<string, unknown>).url === "string" ? (
            <span className="font-mono text-[13px] text-muted-foreground">
              {(event.metadata as Record<string, string>).url}
            </span>
          ) : null}
          {event.metadata && typeof (event.metadata as Record<string, unknown>).bounce_type === "string" ? (
            <span className="font-mono text-[13px] text-muted-foreground">
              {(event.metadata as Record<string, string>).bounce_type}
              {typeof (event.metadata as Record<string, unknown>).bounce_message === "string"
                ? ` - ${(event.metadata as Record<string, string>).bounce_message}`
                : null}
            </span>
          ) : null}
        </p>
        <p className="mt-1 font-mono text-[13px] text-subtle-foreground">
          {formatDateTime(event.occurred_at)}
        </p>
      </div>
    </li>
  );
}

/**
 * The mail in a client-style frame: subject, recipient and date on top, then
 * the rendered HTML at its full height. Plain text and the HTML source are
 * one click away.
 */
function MailView({
  subject,
  to,
  date,
  preheader,
  previewHtml,
  bodyText,
}: {
  subject: string | null;
  to: string | null;
  date: string | null;
  preheader: string | null;
  previewHtml: string | null;
  bodyText: string | null;
}) {
  const [tab, setTab] = useState<"preview" | "text" | "html">(previewHtml ? "preview" : "text");

  if (!previewHtml && !bodyText) {
    return (
      <p className="rounded-lg border border-border bg-card shadow-card p-5 text-[15px] text-muted-foreground">
        No content available (the message may have been suppressed or skipped before content generation).
      </p>
    );
  }

  return (
    <section className="min-w-0">
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
        <div className="border-b border-border px-5 py-4">
          <p className="text-[17px] font-semibold text-foreground">{subject ?? "(no subject)"}</p>
          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[14px] text-muted-foreground">
            <span className="min-w-0 truncate">
              To <span className="font-mono text-foreground">{to ?? "-"}</span>
            </span>
            <span className="font-mono text-[13px]">{formatDateTime(date)}</span>
          </div>
          {preheader && (
            <p className="mt-2 truncate text-[14px] text-subtle-foreground">
              <span className="mr-1.5 text-[12px] font-semibold uppercase tracking-[0.06em]">Preview line</span>
              {preheader}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 border-b border-border px-3">
          {previewHtml && (
            <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>
              As received
            </TabButton>
          )}
          {bodyText && (
            <TabButton active={tab === "text"} onClick={() => setTab("text")}>
              Plain text
            </TabButton>
          )}
          {previewHtml && (
            <TabButton active={tab === "html"} onClick={() => setTab("html")}>
              HTML source
            </TabButton>
          )}
        </div>

        {tab === "preview" && previewHtml && <MailFrame html={previewHtml} />}
        {tab === "text" && bodyText && (
          <pre className="max-h-[720px] overflow-auto whitespace-pre-wrap bg-card p-5 font-mono text-[14px] leading-[22px] text-foreground">
            {bodyText}
          </pre>
        )}
        {tab === "html" && previewHtml && (
          <pre className="max-h-[720px] overflow-auto whitespace-pre-wrap break-all bg-card p-5 font-mono text-[13px] text-muted-foreground">
            {previewHtml}
          </pre>
        )}
      </div>
      <p className="mt-2 text-[13px] text-subtle-foreground">
        Rendered with the flow&apos;s current email template and brand. The unsubscribe link was signed for this
        recipient when it was sent and is a placeholder here.
      </p>
    </section>
  );
}

/** The rendered mail, sized to its content so the page has one scrollbar. */
function MailFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(640);
  const fit = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc?.documentElement) return;
    const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
    if (h > 0) setHeight(Math.min(h + 2, 6000));
    // Images load after the document; measure again once they have.
    for (const img of Array.from(doc.images)) {
      if (!img.complete) img.addEventListener("load", fit, { once: true });
    }
  }, []);
  return (
    <iframe
      ref={ref}
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      title="Message as received"
      srcDoc={html}
      onLoad={fit}
      style={{ height }}
      className="block w-full bg-[#f9fafb]"
    />
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
      className={`px-3 pb-2 pt-1 text-[14px] font-medium transition-colors duration-150 ${
        active
          ? "border-b-2 border-foreground text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
