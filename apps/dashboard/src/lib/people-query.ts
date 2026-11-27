/**
 * People list state <-> URL <-> API filters.
 *
 * Everything the People screen filters and sorts by lives in the address bar
 * (deep links, shareable views, a working back button). This module is the
 * one place that reads those params, turns date presets into instants and
 * builds the GET /v1/contacts filters. Pure: `now` is passed in.
 */
import type { Contact, ContactFilters, ContactSortKey, PaymentStatus } from "../api.js";

export const LIFECYCLE_STATES: ReadonlyArray<Contact["lifecycle_state"]> = [
  "signed_up",
  "activated",
  "engaged",
  "at_risk",
  "dormant",
  "gone_quiet",
  "resurrected",
];

export const ENGAGEMENT_DEPTHS = ["power", "regular", "casual", "minimal"] as const;
export type EngagementDepth = (typeof ENGAGEMENT_DEPTHS)[number];

export const PAYMENT_STATUSES: ReadonlyArray<PaymentStatus> = ["free", "trial", "paid", "past_due", "cancelled"];

export const TENURE_BUCKETS = ["new", "growing", "established", "loyal"] as const;
export const RECENCY_BUCKETS = ["active", "cooling", "idle", "dormant"] as const;
export type TenureBucket = (typeof TENURE_BUCKETS)[number];
export type RecencyBucket = (typeof RECENCY_BUCKETS)[number];

/** paid = payment status paid or past_due, free = any other (GET /v1/contacts?audience=). */
export const AUDIENCES = ["paid", "free"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** The A-Z bar: a..z, then "#" for names that start with anything else. */
export const LETTERS: ReadonlyArray<string> = [..."abcdefghijklmnopqrstuvwxyz".split(""), "#"];

export const DATE_FIELDS = ["joined", "last_seen"] as const;
export type DateField = (typeof DATE_FIELDS)[number];

export const DATE_PRESETS = ["7d", "30d", "90d", "12m", "over30d", "over90d", "custom"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "12m": "Last 12 months",
  over30d: "More than 30 days ago",
  over90d: "More than 90 days ago",
  custom: "Custom range",
};

export const SORT_KEYS: ReadonlyArray<ContactSortKey> = ["name", "joined", "last_seen", "created"];
export type SortOrder = "asc" | "desc";

/** The direction a column sorts in when first clicked. */
export const DEFAULT_ORDER: Record<ContactSortKey, SortOrder> = {
  created: "desc",
  name: "asc",
  joined: "desc",
  last_seen: "desc",
};

export interface PeopleQuery {
  search: string;
  state: Contact["lifecycle_state"] | null;
  depth: EngagementDepth | null;
  payment: PaymentStatus | null;
  letter: string | null;
  dateField: DateField;
  datePreset: DatePreset | null;
  /** YYYY-MM-DD, custom range only. */
  dateFrom: string | null;
  dateTo: string | null;
  tenure: TenureBucket | null;
  recency: RecencyBucket | null;
  /** The Lifecycle page's paid / free split, carried by "Show users". */
  audience: Audience | null;
  /** The sort in the URL; null means the default (see effectiveSort). */
  sort: ContactSortKey | null;
  order: SortOrder | null;
}

function oneOf<T extends string>(values: ReadonlyArray<T>, v: string | null): T | null {
  return v !== null && (values as ReadonlyArray<string>).includes(v) ? (v as T) : null;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function ymd(v: string | null): string | null {
  return v !== null && YMD.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** Read the People state from URL search params; unknown values are ignored. */
export function readPeopleQuery(params: URLSearchParams): PeopleQuery {
  const letter = params.get("letter");
  return {
    search: params.get("q") ?? "",
    state: oneOf(LIFECYCLE_STATES, params.get("state")),
    depth: oneOf(ENGAGEMENT_DEPTHS, params.get("depth")),
    payment: oneOf(PAYMENT_STATUSES, params.get("payment")),
    letter: letter !== null && LETTERS.includes(letter.toLowerCase()) ? letter.toLowerCase() : null,
    dateField: oneOf(DATE_FIELDS, params.get("date_field")) ?? "joined",
    datePreset: oneOf(DATE_PRESETS, params.get("date")),
    dateFrom: ymd(params.get("from")),
    dateTo: ymd(params.get("to")),
    tenure: oneOf(TENURE_BUCKETS, params.get("tenure_bucket")),
    recency: oneOf(RECENCY_BUCKETS, params.get("recency_bucket")),
    audience: oneOf(AUDIENCES, params.get("audience")),
    sort: oneOf(SORT_KEYS, params.get("sort")),
    order: oneOf(["asc", "desc"] as const, params.get("order")),
  };
}

/** URL param names for each PeopleQuery field. */
const PARAM: Record<keyof PeopleQuery, string> = {
  search: "q",
  state: "state",
  depth: "depth",
  payment: "payment",
  letter: "letter",
  dateField: "date_field",
  datePreset: "date",
  dateFrom: "from",
  dateTo: "to",
  tenure: "tenure_bucket",
  recency: "recency_bucket",
  audience: "audience",
  sort: "sort",
  order: "order",
};

/** Write a partial update into the params; null or "" removes the param. */
export function writePeopleQuery(prev: URLSearchParams, patch: Partial<PeopleQuery>): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [field, value] of Object.entries(patch) as Array<[keyof PeopleQuery, string | null]>) {
    const name = PARAM[field];
    if (value === null || value === "" || (field === "dateField" && value === "joined")) next.delete(name);
    else next.set(name, value);
  }
  return next;
}

/**
 * The sort in effect. Without one in the URL: A to Z while a letter is
 * picked (the A-Z bar reads as a directory), otherwise latest joined first.
 */
export function effectiveSort(q: PeopleQuery): { key: ContactSortKey; order: SortOrder } {
  const key = q.sort ?? (q.letter !== null ? "name" : "joined");
  return { key, order: q.order ?? DEFAULT_ORDER[key] };
}

/** The sort after clicking a column header: flip the active column, else its default direction. */
export function nextSort(q: PeopleQuery, key: ContactSortKey): { sort: ContactSortKey; order: SortOrder } {
  const current = effectiveSort(q);
  if (current.key === key) return { sort: key, order: current.order === "asc" ? "desc" : "asc" };
  return { sort: key, order: DEFAULT_ORDER[key] };
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

/** Local midnight of a YYYY-MM-DD day. */
function localDay(v: string): Date {
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/**
 * The date filter as an instant range in the operator's time zone: "Last 7
 * days" is today and the six days before it, a custom range includes both
 * end days. `after` is inclusive, `before` exclusive.
 */
export function dateRange(q: PeopleQuery, now: Date): { after?: string; before?: string } {
  const today = startOfLocalDay(now);
  switch (q.datePreset) {
    case null:
      return {};
    case "7d":
      return { after: addDays(today, -6).toISOString() };
    case "30d":
      return { after: addDays(today, -29).toISOString() };
    case "90d":
      return { after: addDays(today, -89).toISOString() };
    case "12m":
      return { after: new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1).toISOString() };
    case "over30d":
      return { before: addDays(today, -30).toISOString() };
    case "over90d":
      return { before: addDays(today, -90).toISOString() };
    case "custom": {
      const out: { after?: string; before?: string } = {};
      if (q.dateFrom) out.after = localDay(q.dateFrom).toISOString();
      if (q.dateTo) out.before = addDays(localDay(q.dateTo), 1).toISOString();
      return out;
    }
  }
}

/** GET /v1/contacts filters for the state (search is passed settled, after debounce). */
export function toContactFilters(q: PeopleQuery, search: string, now: Date): ContactFilters {
  const f: ContactFilters = {};
  if (search) f.search = search;
  if (q.state) f.lifecycle_state = q.state;
  if (q.depth) f.engagement_depth = q.depth;
  if (q.payment) f.payment_status = q.payment;
  if (q.letter) f.letter = q.letter;
  if (q.tenure) f.tenure_bucket = q.tenure;
  if (q.recency) f.recency_bucket = q.recency;
  if (q.audience) f.audience = q.audience;
  const range = dateRange(q, now);
  if (q.dateField === "joined") {
    if (range.after) f.joined_after = range.after;
    if (range.before) f.joined_before = range.before;
  } else {
    if (range.after) f.last_seen_after = range.after;
    if (range.before) f.last_seen_before = range.before;
  }
  const sort = effectiveSort(q);
  f.sort = sort.key;
  f.order = sort.order;
  return f;
}

/** Whether anything narrows the list (sort alone does not). */
export function isFiltering(q: PeopleQuery): boolean {
  return (
    q.search.trim() !== "" ||
    q.state !== null ||
    q.depth !== null ||
    q.payment !== null ||
    q.letter !== null ||
    q.datePreset !== null ||
    q.tenure !== null ||
    q.recency !== null ||
    q.audience !== null
  );
}

/** The params with every filter removed; the sort stays. */
export function clearedQuery(prev: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  for (const name of ["sort", "order"]) {
    const v = prev.get(name);
    if (v !== null) next.set(name, v);
  }
  return next;
}
