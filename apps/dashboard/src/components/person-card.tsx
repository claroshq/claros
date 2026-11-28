/**
 * Person card: who a draft is going to, without leaving the Approvals page.
 *
 * The trigger is the recipient's name. Hovering it opens the card after a
 * short delay (and the data starts loading at once, so it is usually there
 * by then); moving the pointer onto the card keeps it open. A click, Enter
 * or the page's `p` key pins it open until Escape, a click outside or
 * another click on the name.
 *
 * The card holds what a reviewer needs to judge the draft: identity and
 * lifecycle state, suppression, the flows the person is in, the team's
 * latest notes, a few properties, and the most recent timeline entries
 * (events, state changes and mail), with the draft under review marked.
 * The full profile and timeline stay on the Person page, linked at the
 * bottom.
 *
 * It renders in a portal with fixed positioning, so the scrolling review
 * pane does not clip it; it follows the trigger on scroll and resize.
 */
import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ArrowRight, Mail, RefreshCw, Zap } from "lucide-react";
import { useContact, useContactNotes, useContactTimeline } from "../contacts.js";
import type { TimelineItem } from "../api.js";
import { Badge } from "./ui/badge.js";
import { Skeleton } from "./ui/skeleton.js";
import { cn } from "../lib/utils.js";
import { ago } from "../lib/time.js";
import { stateHint, stateName } from "../lib/lifecycle-names.js";
import { messageVariant, stateVariant } from "../lib/person-badges.js";

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 200;
const CARD_WIDTH = 384;
const GAP = 8;
const TIMELINE_ITEMS = 8;
const PROPERTY_ITEMS = 6;

export interface PersonCardHandle {
  /** Pin the card open, or close it if it is open. */
  toggle: () => void;
}

interface PersonCardProps {
  contactId: string;
  /** The draft under review, marked in the timeline. */
  messageId?: string;
  children: React.ReactNode;
  className?: string;
  ref?: React.Ref<PersonCardHandle>;
}

export function PersonCard({ contactId, messageId, children, className, ref }: PersonCardProps) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  // Set on first hover or focus: data loads before the card shows.
  const [wanted, setWanted] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const card = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const clearTimer = () => window.clearTimeout(timer.current);
  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
    setPinned(false);
  }, []);
  const pin = useCallback(() => {
    clearTimer();
    setWanted(true);
    setOpen(true);
    setPinned(true);
  }, []);

  useImperativeHandle(ref, () => ({ toggle: () => (open ? close() : pin()) }), [open, close, pin]);

  useEffect(() => () => clearTimer(), []);

  function hoverIn() {
    setWanted(true);
    clearTimer();
    if (!open) timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  }
  function hoverOut() {
    clearTimer();
    if (!pinned) timer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }

  // Escape and a click outside close a card.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (trigger.current?.contains(t) || card.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
        onFocus={() => setWanted(true)}
        onClick={() => (open && pinned ? close() : pin())}
        className={cn(
          "max-w-full truncate rounded-sm text-left underline decoration-dotted decoration-1 underline-offset-4 transition-colors duration-(--dur-fast) hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {children}
      </button>
      {wanted && open &&
        createPortal(
          <CardPanel
            ref={card}
            anchor={trigger}
            contactId={contactId}
            messageId={messageId}
            onMouseEnter={() => clearTimer()}
            onMouseLeave={hoverOut}
          />,
          document.body,
        )}
      {wanted && !open && <Prefetch contactId={contactId} />}
    </>
  );
}

/** Starts the three queries on hover, before the card opens. */
function Prefetch({ contactId }: { contactId: string }) {
  useContact(contactId);
  useContactTimeline(contactId);
  useContactNotes(contactId);
  return null;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface Position {
  top: number;
  left: number;
  maxHeight: number;
}

function place(anchor: HTMLElement): Position {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(GAP, Math.min(r.left, vw - CARD_WIDTH - GAP));
  const below = vh - r.bottom - GAP * 2;
  const above = r.top - GAP * 2;
  if (below >= 320 || below >= above) {
    return { top: r.bottom + GAP, left, maxHeight: below };
  }
  return { top: Math.max(GAP, r.top - GAP - Math.min(above, 640)), left, maxHeight: Math.min(above, 640) };
}

function CardPanel({
  ref,
  anchor,
  contactId,
  messageId,
  onMouseEnter,
  onMouseLeave,
}: {
  ref: React.Ref<HTMLDivElement>;
  anchor: React.RefObject<HTMLButtonElement | null>;
  contactId: string;
  messageId?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const [pos, setPos] = useState<Position | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      if (anchor.current) setPos(place(anchor.current));
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchor]);

  if (!pos) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Person"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ top: pos.top, left: pos.left, width: CARD_WIDTH, maxHeight: pos.maxHeight }}
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left shadow-overlay"
    >
      <CardBody contactId={contactId} messageId={messageId} />
    </div>
  );
}

function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return null;
  const s = String(value);
  return s.length > 0 ? s : null;
}

function CardBody({ contactId, messageId }: { contactId: string; messageId?: string }) {
  const contactQuery = useContact(contactId);
  const timeline = useContactTimeline(contactId);
  const notesQuery = useContactNotes(contactId);

  const items = useMemo(
    () => (timeline.data?.pages[0]?.items ?? []).slice(0, TIMELINE_ITEMS),
    [timeline.data],
  );

  if (contactQuery.isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (contactQuery.isError || !contactQuery.data) {
    return <p className="p-4 text-small text-danger">Could not load this person.</p>;
  }

  const { contact, memberships, suppression } = contactQuery.data;
  const displayName = contact.name ?? contact.email ?? contact.external_id;
  const activeFlows = memberships.filter((m) => m.status === "active" || m.status === "paused");
  const notes = (notesQuery.data?.items ?? []).slice(0, 2);
  // Keys starting with _ are internal markers; company is shown above.
  const properties = Object.entries(contact.properties ?? {})
    .filter(([k]) => !k.startsWith("_") && !(k === "company" && contact.company))
    .map(([k, v]) => [k, scalar(v)] as const)
    .filter((e): e is readonly [string, string] => e[1] !== null)
    .slice(0, PROPERTY_ITEMS);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-2 p-4">
          <div>
            <p className="truncate text-title font-semibold text-foreground">{displayName}</p>
            {contact.email && contact.email !== displayName && (
              <p className="truncate text-small text-muted-foreground">{contact.email}</p>
            )}
            <p className="mt-0.5 truncate text-small text-muted-foreground">
              {contact.company && <>{contact.company} · </>}
              <span className="font-mono text-caption">{contact.external_id}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={stateVariant(contact.lifecycle_state)} title={stateHint(contact.lifecycle_state)}>
              {stateName(contact.lifecycle_state)}
            </Badge>
            {contact.engagement_depth && <Badge variant="neutral">{contact.engagement_depth}</Badge>}
            {contact.payment_status && <Badge variant="neutral">{contact.payment_status}</Badge>}
          </div>
          {suppression && (
            <p className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-small text-foreground" role="note">
              Suppressed ({suppression.reason}). This draft will not be sent.
            </p>
          )}
          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-small">
            <dt className="text-muted-foreground">First seen</dt>
            <dd className="text-foreground">{ago(contact.first_seen_at)}</dd>
            <dt className="text-muted-foreground">Last seen</dt>
            <dd className="text-foreground">{ago(contact.last_seen_at)}</dd>
            {contact.activated_at && (
              <>
                <dt className="text-muted-foreground">Activated</dt>
                <dd className="text-foreground">{ago(contact.activated_at)}</dd>
              </>
            )}
          </dl>
        </div>

        {activeFlows.length > 0 && (
          <CardSection title="In flows">
            <ul className="space-y-1 text-small">
              {activeFlows.slice(0, 4).map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-foreground">{m.flow_name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {m.status === "paused" ? "paused · " : ""}step {m.current_step}
                  </span>
                </li>
              ))}
            </ul>
          </CardSection>
        )}

        {notes.length > 0 && (
          <CardSection title="Team notes">
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id} className="text-small">
                  <p className="line-clamp-3 whitespace-pre-wrap text-foreground">{n.body}</p>
                  <p className="mt-0.5 text-caption text-subtle-foreground">
                    {n.author?.name ?? n.author?.email ?? "Someone"}, {ago(n.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          </CardSection>
        )}

        {properties.length > 0 && (
          <CardSection title="Properties">
            <dl className="grid grid-cols-[minmax(0,7.5rem)_1fr] gap-x-3 gap-y-1 text-small">
              {properties.map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt className="truncate font-mono text-caption leading-5 text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 truncate text-foreground" title={v}>{v}</dd>
                </React.Fragment>
              ))}
            </dl>
          </CardSection>
        )}

        <CardSection title="Recent activity">
          {timeline.isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}
          {timeline.isError && <p className="text-small text-danger">Could not load the timeline.</p>}
          {!timeline.isLoading && !timeline.isError && items.length === 0 && (
            <p className="text-small text-muted-foreground">Nothing yet.</p>
          )}
          {items.length > 0 && (
            <ol className="space-y-2">
              {items.map((item) => (
                <MiniTimelineRow key={`${item.kind}:${item.id}`} item={item} current={item.kind === "message" && item.id === messageId} />
              ))}
            </ol>
          )}
        </CardSection>
      </div>

      <Link
        to={`/people/${contact.id}`}
        className="flex shrink-0 items-center justify-between border-t border-border px-4 py-2.5 text-small font-medium text-accent-text transition-colors duration-(--dur-fast) hover:bg-hover"
      >
        Open profile and full timeline
        <ArrowRight className="size-4" aria-hidden />
      </Link>
    </>
  );
}

function CardSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border px-4 py-3">
      <h3 className="mb-2 text-caption font-semibold uppercase tracking-[0.07em] text-subtle-foreground">{title}</h3>
      {children}
    </section>
  );
}

const KIND_ICON = { event: Zap, transition: RefreshCw, message: Mail } as const;
const KIND_TONE: Record<TimelineItem["kind"], string> = {
  event: "bg-accent-soft text-accent-text",
  transition: "bg-sunken text-muted-foreground",
  message: "bg-success-soft text-success",
};

function MiniTimelineRow({ item, current }: { item: TimelineItem; current: boolean }) {
  const Icon = KIND_ICON[item.kind];
  return (
    <li className="flex items-start gap-2.5">
      <span aria-hidden className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full", KIND_TONE[item.kind])}>
        <Icon size={11} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        {item.kind === "event" && (
          <p className="truncate font-mono text-small text-foreground">{item.event_name ?? item.event_type}</p>
        )}
        {item.kind === "transition" && (
          <p className="truncate text-small text-foreground">
            <span className="font-mono">{stateName(item.from_state)}</span>
            <span className="text-subtle-foreground">{" -> "}</span>
            <span className="font-mono">{stateName(item.to_state)}</span>
          </p>
        )}
        {item.kind === "message" && (
          <>
            <p className="truncate text-small text-foreground" title={item.subject ?? undefined}>
              {item.subject ?? "(no subject)"}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-caption text-muted-foreground">
              {current ? <Badge variant="accent">this draft</Badge> : <Badge variant={messageVariant(item.status)}>{item.status}</Badge>}
              <span className="truncate">{item.flow_name}</span>
            </p>
          </>
        )}
      </div>
      <span className="shrink-0 pt-0.5 text-caption text-subtle-foreground">{ago(item.occurred_at)}</span>
    </li>
  );
}
