/**
 * Group time-ordered rows by local calendar day, with human labels:
 * "Today", "Yesterday", a weekday within the last week, then a date
 * ("Nov 18", with the year when it is not the current one).
 */

/** Local calendar day key, YYYY-MM-DD. */
function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Whole calendar days from `d` to `now` (0 = same day), in local time. */
function daysAgo(d: Date, now: Date): number {
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Human label for a day: Today, Yesterday, Monday, Nov 18, Nov 18, 2025. */
export function dayLabel(d: Date, now: Date = new Date()): string {
  const ago = daysAgo(d, now);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago > 1 && ago < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** The full date shown beside a relative label: "Thursday, Nov 27". Null when the label already is the date. */
export function dayDetail(d: Date, now: Date = new Date()): string | null {
  const ago = daysAgo(d, now);
  if (ago < 0 || ago >= 7) return null;
  return d.toLocaleDateString("en-US", {
    ...(ago <= 1 ? { weekday: "long" } : {}),
    month: "short",
    day: "numeric",
  });
}

export interface DayGroup<T> {
  /** Day key, or "none" for rows without a timestamp. */
  key: string;
  label: string;
  detail: string | null;
  rows: T[];
}

/**
 * Consecutive rows that fall on the same local day form one group, in input
 * order. Rows without a timestamp form a group labelled `noneLabel`.
 */
export function groupByDay<T>(
  rows: T[],
  at: (row: T) => string | Date | null,
  noneLabel: string,
  now: Date = new Date(),
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const row of rows) {
    const v = at(row);
    const d = v === null ? null : new Date(v);
    const key = d === null || Number.isNaN(d.getTime()) ? "none" : dayKey(d);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.rows.push(row);
      continue;
    }
    groups.push(
      key === "none" || d === null
        ? { key, label: noneLabel, detail: null, rows: [row] }
        : { key, label: dayLabel(d, now), detail: dayDetail(d, now), rows: [row] },
    );
  }
  return groups;
}
