/**
 * Analytics page.
 *
 * Sending performance: what went out, what landed, what was opened and
 * clicked, what bounced or was suppressed, over the selected range and
 * broken down per flow. Rates are shown with their denominators, and a
 * rate over fewer than LOW_VOLUME_SENT sends is marked as unstable rather
 * than printed as a confident percentage.
 */
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useSendingAnalytics } from "../analytics.js";
import {
  RangeSelect,
  DailyBars,
  TrendLine,
  fillDays,
  type DailyPoint,
} from "../components/charts.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { PageHeader } from "../components/page-header.js";
import { Button } from "../components/ui/button.js";
import { cn } from "../lib/utils.js";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../components/ui/table.js";

/** Below this many sends, a percentage is noise wearing a suit. */
const LOW_VOLUME_SENT = 20;

function pct(part: number, whole: number): string {
  if (whole === 0) return "-";
  return `${Math.round((part / whole) * 100)}%`;
}

/** A percentage below LOW_VOLUME_SENT sends is noise: show counts only. */
function rate(part: number, whole: number): string {
  if (whole < LOW_VOLUME_SENT) return "-";
  return pct(part, whole);
}

type DeltaTone = "good" | "bad" | "neutral";

interface Delta {
  text: string;
  tone: DeltaTone;
}

function StatCard({
  label,
  value,
  sub,
  delta,
  spark,
  sparkLabel,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: Delta | null;
  spark?: DailyPoint[];
  sparkLabel?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card shadow-card p-5 sm:p-6">
      <p className="text-body font-semibold text-muted-foreground">
        {label}
      </p>
      <p className="mt-2.5 text-page font-semibold tracking-[-0.03em] tabular-nums text-foreground">
        {value}
      </p>
      {delta && (
        <p
          className={cn(
            "mt-2 text-body font-medium",
            delta.tone === "good"
              ? "text-success"
              : delta.tone === "bad"
                ? "text-danger"
                : "text-muted-foreground",
          )}
        >
          {delta.text}
        </p>
      )}
      {sub && <p className="mt-0.5 text-small text-muted-foreground">{sub}</p>}
      {spark && sparkLabel && (
        <div className="mt-4">
          {spark.reduce((a, d) => a + d.count, 0) === 0 ? (
            <p
              className="flex items-center text-caption text-subtle-foreground"
              style={{ height: "36px" }}
            >
              No data in this range
            </p>
          ) : (
            <TrendLine
              rows={spark}
              frameLabels={false}
              height={36}
              emptyNote=""
              ariaLabel={sparkLabel}
            />
          )}
        </div>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function rateSub(part: number, whole: number): string {
  return `${part} of ${whole}`;
}

/** Percentage-point delta vs the previous equal-length period, or null
 *  when either period is below the low-volume rule. */
function rateDelta(
  cur: number,
  curWhole: number,
  prev: number,
  prevWhole: number,
  days: number,
  goodWhenUp: boolean,
): Delta | null {
  if (curWhole < LOW_VOLUME_SENT || prevWhole < LOW_VOLUME_SENT) return null;
  const diff = Math.round((cur / curWhole - prev / prevWhole) * 100);
  if (diff === 0) return { text: `level vs previous ${days}d`, tone: "neutral" };
  const tone = diff > 0 === goodWhenUp ? "good" : "bad";
  return { text: `${diff > 0 ? "+" : ""}${diff} pts vs previous ${days}d`, tone };
}

export default function AnalyticsPage() {
  const [days, setDays] = useState<number>(30);
  const query = useSendingAnalytics(days);
  // Previous-period comparison: the 2x window's totals minus the current
  // window's totals give the previous equal-length period (counts are
  // additive). Same pattern as the home screen's week-over-week cards.
  const prevQuery = useSendingAnalytics(days * 2);

  return (
    <div className="mx-auto w-full max-w-[90rem] min-w-0">
      <PageHeader
        eyebrow="Performance"
        title="Analytics"
        subtitle={`Sending performance over the last ${days} days.`}
        actions={<RangeSelect value={days} onChange={setDays} />}
      />

      {query.isLoading && <PageSkeleton />}

      {query.isError && (
        <div
          className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-lead text-foreground">
            Failed to load analytics:{" "}
            {query.error instanceof Error ? query.error.message : "Unknown error"}
          </p>
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {query.data && (
        <div className="min-w-0 space-y-8">
          {/* Totals */}
          <section>
            {(() => {
              const t = query.data.totals;
              const t2 = prevQuery.data?.totals ?? null;
              const prev = t2
                ? {
                    sent: t2.sent - t.sent,
                    opened: t2.opened - t.opened,
                    clicked: t2.clicked - t.clicked,
                    bounced: t2.bounced - t.bounced,
                  }
                : null;

              // Engagement counts come from webhook events, which only
              // exist since engagement_since. Rate deltas are trustworthy
              // only when tracking covers the full comparison window.
              const engagementCoversComparison =
                query.data.engagement_since !== null &&
                new Date(query.data.engagement_since).getTime() <=
                  Date.now() - days * 2 * 86400_000;

              const sentDelta: Delta | null =
                prev === null
                  ? null
                  : t.sent - prev.sent === 0
                    ? { text: `level vs previous ${days}d`, tone: "neutral" }
                    : {
                        text: `${t.sent - prev.sent > 0 ? "+" : ""}${t.sent - prev.sent} vs previous ${days}d`,
                        tone: "neutral",
                      };

              const zero = (day: string): DailyPoint => ({ day, count: 0 });
              const sentSpark = fillDays(
                query.data.days.map((d) => ({ day: d.day, count: d.sent })),
                days,
                zero,
              );
              const opensSpark = fillDays(
                query.data.engagement_days.map((d) => ({ day: d.day, count: d.opens })),
                days,
                zero,
              );
              const clicksSpark = fillDays(
                query.data.engagement_days.map((d) => ({ day: d.day, count: d.clicks })),
                days,
                zero,
              );
              const bouncesSpark = fillDays(
                query.data.engagement_days.map((d) => ({ day: d.day, count: d.bounces })),
                days,
                zero,
              );

              return (
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                  <StatCard
                    label="Sent"
                    value={String(t.sent)}
                    sub={`last ${days} days`}
                    delta={sentDelta}
                    spark={sentSpark}
                    sparkLabel={`Messages sent per day over the last ${days} days`}
                  />
                  <StatCard
                    label="Open rate"
                    value={rate(t.opened, t.sent)}
                    sub={rateSub(t.opened, t.sent)}
                    delta={
                      prev && engagementCoversComparison
                        ? rateDelta(t.opened, t.sent, prev.opened, prev.sent, days, true)
                        : null
                    }
                    spark={opensSpark}
                    sparkLabel={`Opens per day over the last ${days} days`}
                  />
                  <StatCard
                    label="Click rate"
                    value={rate(t.clicked, t.sent)}
                    sub={rateSub(t.clicked, t.sent)}
                    delta={
                      prev && engagementCoversComparison
                        ? rateDelta(t.clicked, t.sent, prev.clicked, prev.sent, days, true)
                        : null
                    }
                    spark={clicksSpark}
                    sparkLabel={`Clicks per day over the last ${days} days`}
                  />
                  <StatCard
                    label="Bounce rate"
                    value={rate(t.bounced, t.sent)}
                    sub={rateSub(t.bounced, t.sent)}
                    delta={
                      prev && engagementCoversComparison
                        ? rateDelta(t.bounced, t.sent, prev.bounced, prev.sent, days, false)
                        : null
                    }
                    spark={bouncesSpark}
                    sparkLabel={`Bounces per day over the last ${days} days`}
                  />
                </div>
              );
            })()}
            {query.data.totals.sent > 0 && query.data.totals.sent < LOW_VOLUME_SENT && (
              <p className="mt-3 text-small text-muted-foreground">
                Rates are hidden below {LOW_VOLUME_SENT} sends; a percentage
                over a handful of messages is noise. Read the counts.
              </p>
            )}
            {(query.data.totals.suppressed > 0 || query.data.totals.failed > 0) && (
              <p className="mt-3 text-body text-muted-foreground">
                Also in range:{" "}
                <span className="font-mono text-small">{query.data.totals.suppressed}</span>{" "}
                suppressed,{" "}
                <span className="font-mono text-small">{query.data.totals.failed}</span>{" "}
                failed.
              </p>
            )}
          </section>

          {/* Sends per day */}
          <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-card p-5 sm:p-6">
            <h2 className="text-heading font-semibold tracking-[-0.015em] text-foreground">
              Sends per day
            </h2>
            <div className="mt-4">
              <DailyBars
                rows={query.data.days.map((d) => ({ day: d.day, count: d.sent }))}
                rangeDays={days}
                emptyNote="Nothing was sent in this range."
                ariaLabel={`Messages sent per day over the last ${days} days`}
              />
            </div>
          </section>

          {/* Opens and clicks per day (from message_events) */}
          {query.data.engagement_days.length > 0 && (
            <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-card p-5 sm:p-6">
              <h2 className="text-heading font-semibold tracking-[-0.015em] text-foreground">
                Opens and clicks per day
              </h2>
              <div className="mt-4">
                <DailyBars
                  rows={query.data.engagement_days.map((d) => ({ day: d.day, count: d.opens }))}
                  rangeDays={days}
                  emptyNote="No open events in this range."
                  ariaLabel={`Opens per day over the last ${days} days`}
                />
                <p className="mt-2 mb-4 text-micro font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  Opens
                </p>
                <DailyBars
                  rows={query.data.engagement_days.map((d) => ({ day: d.day, count: d.clicks }))}
                  rangeDays={days}
                  emptyNote="No click events in this range."
                  ariaLabel={`Clicks per day over the last ${days} days`}
                />
                <p className="mt-2 text-micro font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  Clicks
                </p>
              </div>
              {query.data.engagement_since && (
                <p className="mt-4 border-t border-border pt-3 text-small text-muted-foreground">
                  Event tracking data available since{" "}
                  <span className="font-mono text-caption">
                    {query.data.engagement_since}
                  </span>
                  . Older messages are not included in these trends.
                </p>
              )}
            </section>
          )}

          {query.data.engagement_days.length === 0 && query.data.totals.sent > 0 && (
            <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-card p-5 sm:p-6">
              <h2 className="text-heading font-semibold tracking-[-0.015em] text-foreground">
                Opens and clicks per day
              </h2>
              <div className="mt-4 rounded-md bg-muted px-4 py-3">
                <p className="text-body text-muted-foreground">
                  No delivery events recorded yet. Open and click trends appear
                  here once your transport provider reports engagement events
                  via webhooks.
                </p>
              </div>
            </section>
          )}

          {/* Per flow */}
          <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-card p-5 sm:p-6">
            <h2 className="text-heading font-semibold tracking-[-0.015em] text-foreground">
              Per flow
            </h2>
            <div className="mt-4 min-w-0 overflow-x-auto">
              {query.data.per_flow.length === 0 ? (
                <div className="rounded-md bg-muted px-4 py-3">
                  <p className="text-body text-muted-foreground">
                    No flow activity in this range. When flows send, their
                    performance breaks down here.
                  </p>
                </div>
              ) : (
                <Table framed={false}>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Flow</TableHead>
                    <TableHead className="text-right">Sent</TableHead>
                    <TableHead className="text-right">Opened</TableHead>
                    <TableHead className="text-right">Clicked</TableHead>
                    <TableHead className="text-right">Bounced</TableHead>
                    <TableHead className="text-right">Suppressed</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.per_flow.map((f) => (
                    <TableRow key={f.flow_id}>
                      <TableCell className="font-medium">
                        <Link
                          to={`/flows/${f.flow_id}/edit`}
                          className="text-accent-text underline underline-offset-4"
                        >
                          {f.flow_name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right font-mono text-small text-foreground">
                        {f.sent}
                      </TableCell>
                      <TableCell className="text-right font-mono text-small text-muted-foreground">
                        {f.opened}{" "}
                        {f.sent >= LOW_VOLUME_SENT && (
                          <span className="text-subtle-foreground">
                            ({pct(f.opened, f.sent)})
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-small text-muted-foreground">
                        {f.clicked}{" "}
                        {f.sent >= LOW_VOLUME_SENT && (
                          <span className="text-subtle-foreground">
                            ({pct(f.clicked, f.sent)})
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-small text-muted-foreground">
                        {f.bounced}
                      </TableCell>
                      <TableCell className="text-right font-mono text-small text-muted-foreground">
                        {f.suppressed}
                      </TableCell>
                      <TableCell className="text-right font-mono text-small text-muted-foreground">
                        {f.failed}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
