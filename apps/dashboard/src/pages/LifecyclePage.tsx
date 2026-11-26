/**
 * Lifecycle page - two views, one contact base.
 *
 * Retention grid tab: tenure (how long a contact has been around) crossed
 * with recency (how long they have been quiet, in multiples of the tenant's
 * natural rhythm). It answers "who should we act on now". Clicking a cell
 * opens a full-width detail bar under the grid (identity, count + trend,
 * actions). "Show users" navigates to the People list with the cell's
 * tenure/recency filters applied - People is the canonical contacts list.
 *
 * Movement tab: the exact movement data of the 7-state engine
 * (direction-split daily bars, entries/exits, top transitions).
 *
 * Audience switch (All / Paid / Free, in the URL as ?audience=): both tabs
 * show only the chosen group, split on the contact's CURRENT payment_status
 * (paid = paid or past_due). The grid derives it from the counts it already
 * has (count, paying); movement is filtered server-side. Flow actions stay
 * on the whole cell: a segment flow has no payment filter.
 *
 * The grid's bucket boundaries are computed by the same core functions that
 * drive segment enrollment, so a cell on this screen and the audience of
 * the resulting flow are provably the same set.
 */
import React, { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  useLifecycleAnalytics,
  useRetentionGrid,
  useRetentionGridCellTrend,
} from "../analytics.js";
import { useFlows } from "../flows.js";
import {
  RangeSelect,
  DailySplitBars,
  TrendLine,
  TREND_MIN_POINTS,
  type SplitPoint,
} from "../components/charts.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Button } from "../components/ui/button.js";
import { PageHeader } from "../components/page-header.js";
import { cn } from "../lib/utils.js";
import type { ContactAudience } from "../api.js";

// ---------------------------------------------------------------------------
// Grid vocabulary
// ---------------------------------------------------------------------------

const TENURE_ROWS = [
  { id: "new", label: "New", desc: "just arrived" },
  { id: "growing", label: "Growing", desc: "finding their rhythm" },
  { id: "established", label: "Established", desc: "proven" },
  { id: "loyal", label: "Loyal", desc: "your oldest contacts" },
] as const;

type Tenure = (typeof TENURE_ROWS)[number]["id"];
type Recency = "active" | "cooling" | "idle" | "dormant";

const RECENCY_ACTION: Record<Recency, string> = {
  active: "No rescue needed. A nurture flow keeps the rhythm alive.",
  cooling: "A gentle nudge before they drift further.",
  idle: "A re-engagement flow with a real reason to come back.",
  dormant: "A win-back with your strongest offer, or a graceful sunset.",
};

/**
 * The lifecycle transition a flow for this cell should fire on. Recency
 * maps monotonically onto the decay chain; tenure has no transition
 * equivalent and lives only in the suggested flow name. Active cells are
 * healthy: no transition is offered.
 */
const RECENCY_TRANSITION: Partial<Record<Recency, { from: string; to: string }>> = {
  cooling: { from: "engaged", to: "at_risk" },
  idle: { from: "at_risk", to: "dormant" },
  dormant: { from: "dormant", to: "churned" },
};

/** Cell surface by recency severity. Neutral text on top, always. */
const RECENCY_SURFACE: Record<Recency, string> = {
  active: "bg-success-soft hover:bg-success-soft-hover",
  cooling: "bg-warning-soft hover:bg-warning-soft-hover",
  idle: "bg-warning-soft hover:bg-warning-soft-hover",
  dormant: "bg-danger-soft hover:bg-danger-soft-hover",
};

function tenureRangeLabel(t: Tenure, thresholds: { growing: number; established: number; loyal: number }): string {
  switch (t) {
    case "new": return `< ${thresholds.growing} days`;
    case "growing": return `${thresholds.growing}-${thresholds.established - 1} days`;
    case "established": return `${thresholds.established}-${thresholds.loyal - 1} days`;
    case "loyal": return `${thresholds.loyal}+ days`;
  }
}

function recencyRangeLabel(r: Recency, thresholds: { cooling: number; idle: number; dormant: number }): string {
  switch (r) {
    case "active": return `quiet < ${thresholds.cooling}d`;
    case "cooling": return `quiet ${thresholds.cooling}-${thresholds.idle - 1}d`;
    case "idle": return `quiet ${thresholds.idle}-${thresholds.dormant - 1}d`;
    case "dormant": return `quiet ${thresholds.dormant}d+`;
  }
}

const RECENCY_COLS: Recency[] = ["active", "cooling", "idle", "dormant"];

// ---------------------------------------------------------------------------
// Audience (paid / free split)
// ---------------------------------------------------------------------------

const AUDIENCES: Array<{ id: ContactAudience; label: string }> = [
  { id: "all", label: "All users" },
  { id: "paid", label: "Paid" },
  { id: "free", label: "Free" },
];

function parseAudience(v: string | null): ContactAudience {
  return v === "paid" || v === "free" ? v : "all";
}

/** A grid cell's (or snapshot's) population for the audience. */
function audienceCount(
  row: { count: number; paying: number } | undefined,
  audience: ContactAudience,
): number {
  if (!row) return 0;
  switch (audience) {
    case "paid": return row.paying;
    case "free": return row.count - row.paying;
    default: return row.count;
  }
}

/** "" for all, "paid " / "free " otherwise: reads as "46 paid contacts". */
function audienceWord(audience: ContactAudience): string {
  return audience === "all" ? "" : `${audience} `;
}

function AudienceSwitch({
  value,
  onChange,
}: {
  value: ContactAudience;
  onChange: (a: ContactAudience) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Audience"
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5"
    >
      {AUDIENCES.map((a) => (
        <button
          key={a.id}
          type="button"
          role="radio"
          aria-checked={value === a.id}
          onClick={() => onChange(a.id)}
          className={cn(
            "h-7 rounded-sm px-3 text-[13px] transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === a.id
              ? "bg-secondary font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One line saying what "paid" and "free" mean; nothing for all. Movement
 * adds that the split is by today's status, not the status at transition.
 */
function AudienceNote({
  audience,
  movement = false,
}: {
  audience: ContactAudience;
  movement?: boolean;
}) {
  if (audience === "all") return null;
  return (
    <p className="text-[12px] leading-relaxed text-subtle-foreground">
      {audience === "paid"
        ? "Paid: payment status paid or past due."
        : "Free: everyone not paying (free, trial, cancelled or no payment status)."}
      {movement
        ? " Transitions are grouped by each contact's payment status today, not at the time they moved."
        : " By each contact's payment status today."}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

interface GridProps {
  grid: NonNullable<ReturnType<typeof useRetentionGrid>["data"]>;
  audience: ContactAudience;
  selected: { tenure: Tenure; recency: Recency } | null;
  onSelect: (tenure: Tenure, recency: Recency) => void;
}

function RetentionGrid({ grid, audience, selected, onSelect }: GridProps) {
  const cellMap = useMemo(() => {
    const map = new Map<string, { count: number; paying: number }>();
    for (const c of grid.cells) {
      map.set(`${c.tenure}:${c.recency}`, { count: c.count, paying: c.paying });
    }
    return map;
  }, [grid.cells]);

  return (
    <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <div
        role="grid"
        aria-label="Retention grid: tenure by recency"
        className="grid gap-1.5"
        style={{ gridTemplateColumns: "minmax(90px, auto) repeat(4, minmax(80px, 1fr))" }}
      >
      {/* Column headers */}
      <div />
      {RECENCY_COLS.map((r) => (
        <div key={r} className="px-2 pb-1 text-center">
          <p className="text-[12px] font-semibold capitalize text-foreground">{r}</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {recencyRangeLabel(r, grid.recency_thresholds_days)}
          </p>
        </div>
      ))}

      {TENURE_ROWS.map((row) => (
        <React.Fragment key={row.id}>
          <div className="flex flex-col justify-center pr-2">
            <p className="text-[12px] font-semibold text-foreground">{row.label}</p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {tenureRangeLabel(row.id, grid.tenure_thresholds_days)}
            </p>
          </div>
          {RECENCY_COLS.map((recency) => {
            const cell = cellMap.get(`${row.id}:${recency}`);
            const count = audienceCount(cell, audience);
            // The paying sub-count only adds information when showing everyone.
            const paying = audience === "all" ? (cell?.paying ?? 0) : 0;
            const isSelected = selected?.tenure === row.id && selected?.recency === recency;
            return (
              <button
                key={recency}
                type="button"
                onClick={() => onSelect(row.id, recency)}
                aria-label={`${row.label} ${recency}: ${count} ${audienceWord(audience)}contacts`}
                className={cn(
                  "rounded-md px-3 py-3 text-center transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  count === 0 ? "bg-sunken hover:bg-sunken-hover" : RECENCY_SURFACE[recency],
                  isSelected && "ring-2 ring-ring",
                )}
              >
                <span
                  className={cn(
                    "block text-[20px] font-semibold leading-none tracking-[-0.01em]",
                    count === 0 ? "text-subtle-foreground" : "text-foreground",
                  )}
                >
                  {count === 0 ? "·" : count}
                </span>
                {paying > 0 && (
                  <span className="mt-1 block text-[11px] font-medium text-muted-foreground">
                    {paying} paying
                  </span>
                )}
              </button>
            );
          })}
        </React.Fragment>
      ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail bar (full width, under the grid) + contacts table (below it)
// ---------------------------------------------------------------------------

/** Fixed window for the per-cell trend sparkline in the detail panel. */
const CELL_TREND_DAYS = 30;

function formatShortDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** Shared per-cell computations: count, trend rows, delta. */
function useCellData(
  grid: NonNullable<ReturnType<typeof useRetentionGrid>["data"]>,
  tenure: Tenure,
  recency: Recency,
  audience: ContactAudience,
) {
  const cell = grid.cells.find((c) => c.tenure === tenure && c.recency === recency);
  const count = audienceCount(cell, audience);
  const paying = audience === "all" ? (cell?.paying ?? 0) : 0;
  // Flow actions target the whole cell whatever the audience.
  const cellTotal = cell?.count ?? 0;

  const trendQuery = useRetentionGridCellTrend(tenure, recency, CELL_TREND_DAYS);

  // Snapshot history plus the live count as today's (possibly only) point.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const trendRows = useMemo(() => {
    const rows = (trendQuery.data?.days ?? []).map((d) => ({
      day: d.day,
      count: audienceCount(d, audience),
    }));
    if (rows[rows.length - 1]?.day !== todayUtc) {
      rows.push({ day: todayUtc, count });
    }
    return rows;
  }, [trendQuery.data, count, todayUtc, audience]);

  // Delta over the recorded window. Growth in the active cell is good news;
  // growth in a quiet cell means more people drifting, so it reads as bad.
  // Gated on the same minimum as the chart: a two-day difference is noise.
  const delta =
    trendRows.length >= TREND_MIN_POINTS ? count - trendRows[0]!.count : null;
  const deltaGood = delta !== null && delta !== 0 && (recency === "active" ? delta > 0 : delta < 0);

  return { count, paying, cellTotal, trendQuery, trendRows, delta, deltaGood };
}

function CellDetail({
  grid,
  tenure,
  recency,
  audience,
}: {
  grid: NonNullable<ReturnType<typeof useRetentionGrid>["data"]>;
  tenure: Tenure;
  recency: Recency;
  audience: ContactAudience;
}) {
  const flowsQuery = useFlows();
  const navigate = useNavigate();
  const tenureRow = TENURE_ROWS.find((t) => t.id === tenure)!;
  const { count, paying, cellTotal, trendQuery, trendRows, delta, deltaGood } =
    useCellData(grid, tenure, recency, audience);
  const transition = RECENCY_TRANSITION[recency] ?? null;

  // Flows already covering this cell: a segment flow targeting it, or a
  // lifecycle-transition flow firing on its mapped transition.
  const flows = flowsQuery.data?.flows ?? [];
  const existingSegmentFlow = flows.find((f) => {
    if (f.trigger_type !== "segment") return false;
    const cfg = (f.trigger_config ?? {}) as Record<string, unknown>;
    return cfg.tenure_bucket === tenure && cfg.recency_bucket === recency;
  });
  const existingTransitionFlow = transition
    ? flows.find((f) => {
        if (f.trigger_type !== "lifecycle_transition") return false;
        const cfg = (f.trigger_config ?? {}) as Record<string, unknown>;
        return cfg.from === transition.from && cfg.to === transition.to;
      })
    : undefined;

  return (
    <section className="mt-6 rounded-lg border border-border bg-card p-5">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_240px]">
        {/* Identity + guidance */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-text">
            Selected cell
          </p>
          <h3 className="mt-1 text-[18px] font-semibold tracking-[-0.01em] text-foreground">
            {tenureRow.label} · <span className="capitalize">{recency}</span>
          </h3>
          <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
            {tenureRow.desc.charAt(0).toUpperCase() + tenureRow.desc.slice(1)}{" "}
            ({tenureRangeLabel(tenure, grid.tenure_thresholds_days)}),{" "}
            {recencyRangeLabel(recency, grid.recency_thresholds_days)}.
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
            {RECENCY_ACTION[recency]}
          </p>
        </div>

        {/* Evidence: count, delta, trend */}
        <div>
          <p className="font-display text-[28px] font-bold leading-none tracking-[-0.02em] text-foreground">
            {count}
            <span className="ml-2 text-[14px] font-normal text-muted-foreground">
              {audienceWord(audience)}
              {count === 1 ? "contact" : "contacts"}
              {paying > 0 && ` · ${paying} paying`}
            </span>
          </p>
          {delta !== null && (
            <p className="mt-1.5 text-[13px]">
              <span
                className={cn(
                  "font-mono font-medium",
                  delta === 0
                    ? "text-muted-foreground"
                    : deltaGood
                      ? "text-success"
                      : "text-danger",
                )}
              >
                {delta > 0 ? `+${delta}` : delta}
              </span>{" "}
              <span className="text-muted-foreground">
                since {formatShortDay(trendRows[0]!.day)}
              </span>
            </p>
          )}
          <div className="mt-4">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              Population, last {CELL_TREND_DAYS} days
            </p>
            {trendQuery.isError ? (
              <p className="text-[13px] text-muted-foreground">
                Could not load the trend.
              </p>
            ) : (
              <TrendLine
                rows={trendRows}
                emptyNote="The trend appears after a week of daily snapshots."
                ariaLabel={`Daily ${audienceWord(audience)}population of the ${tenureRow.label} ${recency} cell over the last ${CELL_TREND_DAYS} days`}
              />
            )}
          </div>
        </div>

        {/* Actions: full-width stack, no wrapping */}
        <div className="flex flex-col gap-2">
          {!existingSegmentFlow && (
            <Button
              className="w-full"
              disabled={cellTotal === 0}
              onClick={() => navigate(`/flows/new?segment=${tenure}:${recency}`)}
            >
              Create flow for this segment
            </Button>
          )}
          <Button
            variant="outline"
            className="w-full"
            disabled={count === 0}
            onClick={() =>
              navigate(
                `/people?tenure_bucket=${tenure}&recency_bucket=${recency}${audience === "all" ? "" : `&audience=${audience}`}`,
              )
            }
          >
            Show users
          </Button>

          {existingSegmentFlow ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              A segment flow already targets this cell:{" "}
              <Link
                to={`/flows/${existingSegmentFlow.id}/edit`}
                className="text-accent-text underline underline-offset-4"
              >
                {existingSegmentFlow.name}
              </Link>
            </p>
          ) : (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {cellTotal === 0
                ? "This cell is empty right now."
                : `Reaches the ${cellTotal} ${cellTotal === 1 ? "contact" : "contacts"} already here, and everyone who enters this cell later.`}
              {cellTotal > 0 && audience !== "all" && " Flows target the whole cell, paid and free."}
            </p>
          )}

          {transition && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {existingTransitionFlow ? (
                <>
                  The {transition.from} → {transition.to} transition is covered
                  by{" "}
                  <Link
                    to={`/flows/${existingTransitionFlow.id}/edit`}
                    className="text-accent-text underline underline-offset-4"
                  >
                    {existingTransitionFlow.name}
                  </Link>
                  .
                </>
              ) : (
                <>
                  Or{" "}
                  <Link
                    to={`/flows/new?transition=${transition.from}:${transition.to}&name=${encodeURIComponent(`${tenureRow.label} · ${recency}`)}`}
                    className="text-accent-text underline underline-offset-4"
                  >
                    start from the {transition.from} → {transition.to} transition
                  </Link>{" "}
                  instead: catches only contacts who drift here from now on.
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page states
// ---------------------------------------------------------------------------

function PageSkeleton() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

const BAD_STATES = new Set(["at_risk", "dormant", "churned"]);

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type Tab = "grid" | "movement";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "grid", label: "Retention grid" },
  { id: "movement", label: "Movement" },
];

function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Lifecycle views"
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "h-7 rounded-sm px-3 text-[13px] transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tab === t.id
              ? "bg-secondary font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function LifecyclePage() {
  const [tab, setTab] = useState<Tab>("grid");
  const [days, setDays] = useState<number>(30);
  // In the URL so it survives reloads and "Back to Lifecycle" from People.
  const [searchParams, setSearchParams] = useSearchParams();
  const audience = parseAudience(searchParams.get("audience"));
  const setAudience = (a: ContactAudience) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (a === "all") next.delete("audience");
        else next.set("audience", a);
        return next;
      },
      { replace: true },
    );
  const gridQuery = useRetentionGrid();
  const movementQuery = useLifecycleAnalytics(days, audience);
  const [selected, setSelected] = useState<{ tenure: Tenure; recency: Recency } | null>(null);

  const activeQuery = tab === "grid" ? gridQuery : movementQuery;
  const isLoading = activeQuery.isLoading;
  const isError = activeQuery.isError;

  const gridTotal = gridQuery.data
    ? gridQuery.data.cells.reduce((acc, c) => acc + audienceCount(c, audience), 0)
    : 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Retention"
        title="Lifecycle"
        subtitle={
          gridQuery.data
            ? `${gridTotal} ${audienceWord(audience)}${gridTotal === 1 ? "contact" : "contacts"} on the grid, right now`
            : "Who your contacts are, how long they have been quiet, and where to act."
        }
      />

      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <TabBar tab={tab} onChange={setTab} />
        <AudienceSwitch value={audience} onChange={setAudience} />
      </div>

      {isLoading && <PageSkeleton />}

      {isError && (
        <div
          className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[15px] text-foreground">
            Failed to load lifecycle data.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              gridQuery.refetch();
              movementQuery.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      )}

      {tab === "grid" && gridQuery.data && (
        <section className="mb-10">
          <RetentionGrid
            grid={gridQuery.data}
            audience={audience}
            selected={selected}
            onSelect={(tenure, recency) => {
              setSelected(
                selected?.tenure === tenure && selected?.recency === recency
                  ? null
                  : { tenure, recency },
              );
            }}
          />
          <p className="mt-3 text-[12px] text-subtle-foreground">
            Recency thresholds follow your natural rhythm of{" "}
            {gridQuery.data.natural_frequency_days} days. Cell populations
            are snapshotted daily - click a cell for its trend and actions.
          </p>
          <div className="mt-1">
            <AudienceNote audience={audience} />
          </div>

          {selected ? (
            <CellDetail
              grid={gridQuery.data}
              tenure={selected.tenure}
              recency={selected.recency}
              audience={audience}
            />
          ) : (
            <div className="mt-6 rounded-lg border border-dashed border-border-strong px-5 py-4">
              <p className="text-[14px] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">
                  Pick a cell to act on it.
                </span>{" "}
                Each cell is a group of contacts with the same story: how long
                they have been around and how long they have been quiet.
              </p>
            </div>
          )}
        </section>
      )}

      {tab === "movement" && movementQuery.data && (
        <div className="space-y-8">
          <p className="max-w-2xl text-[12px] leading-relaxed text-subtle-foreground">
            Two vocabularies, one contact base: the retention grid is your
            strategic map (tenure x quiet time, actionable per cell). The
            seven lifecycle states below are the engine's mechanics - they
            drive flow triggers, step conditions, and the movement data. They
            overlap by design but measure differently, so a contact can be
            "engaged" and "cooling" at once.
          </p>

          {/* Movement */}
          <section>
            <div className="mb-1 flex items-center justify-between gap-4">
              <h2 className="text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">
                Movement
              </h2>
              <RangeSelect value={days} onChange={setDays} />
            </div>
            <p className="mb-3 text-[13px] text-muted-foreground">
              Lifecycle transitions per day over the last {days} days, split
              by direction.
            </p>
            <div className="-mt-2 mb-3">
              <AudienceNote audience={audience} movement />
            </div>
            <DailySplitBars
              rows={movementQuery.data.movement.days.map((d): SplitPoint => ({
                day: d.day,
                positive: d.positive,
                negative: d.negative,
              }))}
              rangeDays={days}
              emptyNote="No lifecycle changes in this range."
              ariaLabel={`Lifecycle transitions per day over the last ${days} days, split by direction`}
            />
          </section>

          <div className="grid gap-8 lg:grid-cols-2">
            {/* Entries and exits per state */}
            <section>
              <h2 className="mb-4 text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">
                Entries and exits per state
              </h2>
              {movementQuery.data.movement.per_state.length === 0 ? (
                <p className="text-[14px] text-muted-foreground">
                  No movement in this range.
                </p>
              ) : (
                <table className="w-full table-fixed text-[14px]">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="w-[40%] pb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                        State
                      </th>
                      <th className="w-[20%] pb-2 text-right text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                        Entered
                      </th>
                      <th className="w-[20%] pb-2 text-right text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                        Left
                      </th>
                      <th className="w-[20%] pb-2 text-right text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                        Net
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {movementQuery.data.movement.per_state.map((row) => {
                      const net = row.entered - row.exited;
                      const bad = BAD_STATES.has(row.state);
                      const netIsProblem =
                        net !== 0 && (bad ? net > 0 : row.state === "engaged" && net < 0);
                      const netIsGood =
                        net !== 0 &&
                        !netIsProblem &&
                        (bad ? net < 0 : row.state !== "signed_up" && net > 0);
                      return (
                        <tr key={row.state} className="h-9 border-b border-border last:border-0">
                          <td>
                            <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[12px] text-foreground">
                              {row.state}
                            </span>
                          </td>
                          <td className="text-right font-mono text-[13px] text-muted-foreground">
                            {row.entered}
                          </td>
                          <td className="text-right font-mono text-[13px] text-muted-foreground">
                            {row.exited}
                          </td>
                          <td
                            className={cn(
                              "text-right font-mono text-[13px]",
                              netIsProblem
                                ? "text-danger"
                                : netIsGood
                                  ? "text-success"
                                  : "text-muted-foreground",
                            )}
                          >
                            {net > 0 ? `+${net}` : net}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>

            {/* Top transitions */}
            <section>
              <h2 className="mb-4 text-[20px] font-semibold leading-[28px] tracking-[-0.015em] text-foreground">
                Most frequent transitions
              </h2>
              {movementQuery.data.movement.edges.length === 0 ? (
                <p className="text-[14px] text-muted-foreground">
                  No movement in this range.
                </p>
              ) : (
                <div>
                  <div className="flex items-center justify-between border-b border-border pb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    <span>Transition</span>
                    <span>Count</span>
                  </div>
                  <ul>
                    {(() => {
                      const edges = movementQuery.data.movement.edges.slice(0, 7);
                      const max = Math.max(1, ...edges.map((e) => e.count));
                      return edges.map((e) => (
                        <li
                          key={`${e.from_state}-${e.to_state}`}
                          className="border-b border-border last:border-0"
                        >
                          <div className="flex h-9 items-center gap-2.5 text-[14px]">
                            <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[12px] text-muted-foreground">
                              {e.from_state}
                            </span>
                            <span aria-hidden="true" className="text-subtle-foreground">
                              {"->"}
                            </span>
                            <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[12px] text-foreground">
                              {e.to_state}
                            </span>
                            <div className="h-1 min-w-0 flex-1 rounded-full bg-sunken">
                              <div
                                className="h-1 rounded-full bg-accent"
                                style={{ width: `${(e.count / max) * 100}%` }}
                              />
                            </div>
                            <span className="w-10 shrink-0 text-right font-mono text-[13px] text-muted-foreground">
                              {e.count}
                            </span>
                          </div>
                        </li>
                      ));
                    })()}
                  </ul>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
