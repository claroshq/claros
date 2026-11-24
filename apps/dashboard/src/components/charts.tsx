/**
 * Hand-rolled SVG charts.
 *
 * Every colour comes from a token (var() references into the app's theme,
 * so both themes work with no per-chart logic). No library, no animation
 * beyond the global motion rules. Every chart carries an sr-only data
 * table so the numbers are readable without the picture.
 *
 * Zero-data discipline: a chart of nothing renders its frame with a
 * centred note, never a blank box and never fabricated sample data.
 */
import * as React from "react";
import { useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Shared hover infrastructure
//
// Every bar chart gets a hover band over the active day and a tooltip card
// anchored above the chart, following the cursor horizontally and clamped
// to the chart's edges. The sr-only data table remains for non-pointer
// access; this is the pointer layer, not a replacement for it.
// ---------------------------------------------------------------------------

interface HoverState {
  index: number;
  /** cursor x within the container, px */
  x: number;
}

function useSlotHover(slotCount: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  function onMouseMove(e: React.MouseEvent) {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const index = Math.floor((x / rect.width) * slotCount);
    if (index >= 0 && index < slotCount) {
      setHover({ index, x });
    } else {
      setHover(null);
    }
  }

  return {
    ref,
    hover,
    onMouseMove,
    onMouseLeave: () => setHover(null),
  };
}

function ChartTooltip({
  hover,
  containerWidth,
  children,
}: {
  hover: HoverState;
  containerWidth: number;
  children: React.ReactNode;
}) {
  // Clamp so the card never leaves the chart's horizontal bounds.
  const x = Math.min(Math.max(hover.x, 70), containerWidth - 70);
  return (
    <div
      role="status"
      className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-card px-2.5 py-1.5 text-[13px] text-foreground"
      style={{ left: `${x}px` }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RangeSelect: bounded time range picker shared by both analytics screens.
// ---------------------------------------------------------------------------

export const RANGE_OPTIONS = [7, 30, 90] as const;

export function RangeSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (days: number) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5"
    >
      {RANGE_OPTIONS.map((d) => (
        <button
          key={d}
          type="button"
          role="radio"
          aria-checked={value === d}
          onClick={() => onChange(d)}
          className={
            value === d
              ? "h-6 rounded-sm bg-secondary px-2.5 text-[13px] font-medium text-foreground transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              : "h-6 rounded-sm px-2.5 text-[13px] text-muted-foreground transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          }
        >
          {d}d
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export interface DailyPoint {
  day: string; // ISO date (YYYY-MM-DD)
  count: number;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Expand sparse server rows into a full day range ending today, zero-filled. */
export function fillDays<T extends { day: string }>(
  rows: T[],
  rangeDays: number,
  zero: (day: string) => T,
): T[] {
  const map = new Map(rows.map((r) => [r.day.slice(0, 10), r]));
  const out: T[] = [];
  const today = new Date();
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000);
    const key = isoDay(d);
    out.push(map.get(key) ?? zero(key));
  }
  return out;
}

function FrameLabels({ first, last }: { first: string; last: string }) {
  return (
    <div className="mt-1 flex justify-between font-mono text-[12px] text-subtle-foreground">
      <span>{formatDay(first)}</span>
      <span>{formatDay(last)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DailyBars: one slim bar per calendar day, single series.
// ---------------------------------------------------------------------------

export function DailyBars({
  rows,
  rangeDays,
  emptyNote,
  ariaLabel,
}: {
  rows: DailyPoint[];
  rangeDays: number;
  emptyNote: string;
  ariaLabel: string;
}) {
  const data = fillDays(rows, rangeDays, (day) => ({ day, count: 0 }));
  const max = Math.max(1, ...data.map((d) => d.count));
  const total = data.reduce((a, d) => a + d.count, 0);
  const { ref, hover, onMouseMove, onMouseLeave } = useSlotHover(data.length);

  const W = 640;
  const H = 96;
  const slot = W / data.length;

  return (
    <figure className="m-0">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[12px] text-subtle-foreground">
          max {max === 1 && total === 0 ? 0 : max}
        </span>
        <span className="font-mono text-[12px] text-subtle-foreground">
          {total} total
        </span>
      </div>
      <div
        ref={ref}
        className="relative"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        {hover && (
          <ChartTooltip hover={hover} containerWidth={ref.current?.getBoundingClientRect().width ?? W}>
            <span className="font-mono text-[12px] text-muted-foreground">
              {formatDay(data[hover.index]!.day)}
            </span>{" "}
            <span className="font-medium">{data[hover.index]!.count}</span>
          </ChartTooltip>
        )}
        <div role="img" aria-label={ariaLabel}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="mt-1 block h-[96px] w-full"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {hover && (
              <rect
                x={(hover.index * slot * 100) / 100}
                y={0}
                width={slot}
                height={H}
                fill="var(--bg-sunken)"
              />
            )}
            <line x1="0" y1={H - 1} x2={W} y2={H - 1} stroke="var(--border)" strokeWidth="1" />
            {data.map((d, i) => {
              if (d.count === 0) return null;
              const h = Math.max(2, ((H - 10) * d.count) / max);
              return (
                <rect
                  key={d.day}
                  x={i * slot + slot * 0.25}
                  y={H - 1 - h}
                  width={Math.max(1, slot * 0.5)}
                  height={h}
                  rx={Math.min(1.5, slot * 0.2)}
                  fill="var(--accent)"
                  style={hover?.index === i ? { filter: "brightness(1.18)" } : undefined}
                />
              );
            })}
          </svg>
        </div>
      </div>
      <FrameLabels first={data[0]!.day} last={data[data.length - 1]!.day} />
      {total === 0 && (
        <p className="mt-2 text-center text-[14px] text-muted-foreground">
          {emptyNote}
        </p>
      )}
      <div className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <tbody>
            {data.map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td>{d.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// DailySplitBars: diverging per-day bars - good movement rises above the
// zero line in pastel chart-positive, bad movement sinks below it in
// pastel chart-negative. Legend text and values keep the full semantic
// tones for contrast.
// ---------------------------------------------------------------------------

export interface SplitPoint {
  day: string;
  positive: number;
  negative: number;
}

export function DailySplitBars({
  rows,
  rangeDays,
  emptyNote,
  ariaLabel,
}: {
  rows: SplitPoint[];
  rangeDays: number;
  emptyNote: string;
  ariaLabel: string;
}) {
  const data = fillDays(rows, rangeDays, (day) => ({ day, positive: 0, negative: 0 }));
  const maxPos = Math.max(1, ...data.map((d) => d.positive));
  const maxNeg = Math.max(1, ...data.map((d) => d.negative));
  const totalPos = data.reduce((a, d) => a + d.positive, 0);
  const totalNeg = data.reduce((a, d) => a + d.negative, 0);
  const net = totalPos - totalNeg;
  const { ref, hover, onMouseMove, onMouseLeave } = useSlotHover(data.length);

  const W = 640;
  const H = 120;
  const zero = H / 2;
  const half = zero - 8;
  const slot = W / data.length;

  return (
    <figure className="m-0">
      <div className="flex items-baseline justify-between">
        <div className="flex gap-4 font-mono text-[12px] text-subtle-foreground">
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-chart-positive" />
            {totalPos} into good states
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-chart-negative" />
            {totalNeg} into bad states
          </span>
        </div>
        <span className="font-mono text-[12px] text-subtle-foreground">
          {totalPos + totalNeg} total
          {" · net "}
          <span
            className={
              net > 0 ? "text-success" : net < 0 ? "text-danger" : "text-subtle-foreground"
            }
          >
            {net > 0 ? `+${net}` : net}
          </span>
        </span>
      </div>
      <div
        ref={ref}
        className="relative"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        {hover && (
          <ChartTooltip hover={hover} containerWidth={ref.current?.getBoundingClientRect().width ?? W}>
            <span className="font-mono text-[12px] text-muted-foreground">
              {formatDay(data[hover.index]!.day)}
            </span>{" "}
            <span className="text-success">{data[hover.index]!.positive}</span>
            {" / "}
            <span className="text-danger">{data[hover.index]!.negative}</span>
          </ChartTooltip>
        )}
        <div role="img" aria-label={ariaLabel}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="mt-1 block h-[120px] w-full"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {hover && (
              <rect
                x={hover.index * slot}
                y={0}
                width={slot}
                height={H}
                fill="var(--bg-sunken)"
              />
            )}
            {/* Zero line: the pivot between good and bad movement. */}
            <line x1="0" y1={zero - 0.5} x2={W} y2={zero - 0.5} stroke="var(--border-strong)" strokeWidth="1" />
            {data.map((d, i) => {
              if (d.positive === 0 && d.negative === 0) return null;
              const x = i * slot + slot * 0.3;
              const w = Math.max(1, slot * 0.4);
              const r = Math.min(1.5, w * 0.25);
              const hPos = d.positive === 0 ? 0 : Math.max(2, (half * d.positive) / maxPos);
              const hNeg = d.negative === 0 ? 0 : Math.max(2, (half * d.negative) / maxNeg);
              return (
                <g key={d.day}>
                  {d.positive > 0 && (
                    <rect
                      x={x}
                      y={zero - 1 - hPos}
                      width={w}
                      height={hPos}
                      rx={r}
                      fill="var(--chart-positive)"
                      style={hover?.index === i ? { filter: "brightness(1.18)" } : undefined}
                    />
                  )}
                  {d.negative > 0 && (
                    <rect
                      x={x}
                      y={zero + 1}
                      width={w}
                      height={hNeg}
                      rx={r}
                      fill="var(--chart-negative)"
                      style={hover?.index === i ? { filter: "brightness(1.18)" } : undefined}
                    />
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <FrameLabels first={data[0]!.day} last={data[data.length - 1]!.day} />
      {totalPos + totalNeg === 0 && (
        <p className="mt-2 text-center text-[14px] text-muted-foreground">
          {emptyNote}
        </p>
      )}
      <div className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <thead>
            <tr>
              <th>day</th>
              <th>into good states</th>
              <th>into bad states</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td>{d.positive}</td>
                <td>{d.negative}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// TrendLine: a compact sparkline for a daily population series (e.g. one
// retention-grid cell over time). No zero-fill: the caller passes exactly
// the days that have data, so history that has not been recorded yet shows
// as a shorter line, never as fabricated zeros.
// ---------------------------------------------------------------------------

/**
 * A line claims a trend; fewer than a week of daily points is noise, not a
 * trend. Below the minimum the component renders only the caller's note.
 * Exported so callers can gate derived stats (e.g. deltas) on the same rule.
 */
export const TREND_MIN_POINTS = 7;

export function TrendLine({
  rows,
  emptyNote,
  ariaLabel,
  frameLabels = true,
  height = 56,
}: {
  rows: DailyPoint[];
  emptyNote: string;
  ariaLabel: string;
  /** Hide the first/last date labels (compact contexts like stat cards). */
  frameLabels?: boolean;
  /** Chart height in px. Smaller values suit stat-card sparklines. */
  height?: number;
}) {
  if (rows.length < TREND_MIN_POINTS) {
    return (
      <figure className="m-0">
        <p className="text-[12px] text-subtle-foreground">{emptyNote}</p>
        <div className="sr-only">
          <table>
            <caption>{ariaLabel}</caption>
            <tbody>
              {rows.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td>{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </figure>
    );
  }

  const W = 320;
  const H = height;
  const PAD = 3;
  const max = Math.max(1, ...rows.map((d) => d.count));

  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / (rows.length - 1);
  const y = (count: number) => H - PAD - ((H - 2 * PAD) * count) / max;

  const points = rows.map((d, i) => `${x(i)},${y(d.count)}`).join(" ");
  const last = rows[rows.length - 1]!;

  return (
    <figure className="m-0">
      <div role="img" aria-label={ariaLabel}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full"
          style={{ height: `${H}px` }}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line
            x1={0}
            y1={H - 1}
            x2={W}
            y2={H - 1}
            stroke="var(--border)"
            strokeWidth="1"
          />
          <polyline
            points={points}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          <circle
            cx={x(rows.length - 1)}
            cy={y(last.count)}
            r="2.5"
            fill="var(--accent)"
          />
        </svg>
      </div>
      {frameLabels && <FrameLabels first={rows[0]!.day} last={last.day} />}
      <div className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <tbody>
            {rows.map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td>{d.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// DepthStrip: a thin segmented bar, the engagement depth of one state.
// ---------------------------------------------------------------------------

export const DEPTH_FILLS = {
  power: "var(--accent)",
  regular: "var(--accent-text)",
  casual: "var(--fg-muted)",
  minimal: "var(--border-strong)",
  unset: "var(--border)",
} as const;

export function DepthStrip({
  segments,
}: {
  segments: Array<{ key: keyof typeof DEPTH_FILLS; count: number }>;
}) {
  const total = segments.reduce((a, s) => a + s.count, 0);
  if (total === 0) {
    return <div className="h-1 rounded-full bg-sunken" />;
  }
  return (
    <div className="flex h-1 overflow-hidden rounded-full" role="img" aria-label="engagement depth breakdown">
      {segments
        .filter((s) => s.count > 0)
        .map((s) => (
          <div
            key={s.key}
            style={{ width: `${(s.count / total) * 100}%`, background: DEPTH_FILLS[s.key] }}
          >
            <span className="sr-only">{`${s.key}: ${s.count}`}</span>
          </div>
        ))}
    </div>
  );
}
