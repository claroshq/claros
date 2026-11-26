/**
 * People list page.
 *
 * A table people scan for a long time: 13px cells, micro-label headers,
 * 1px separators, dot badges for lifecycle state. Search matches email,
 * name and external id; filters cover lifecycle state, engagement depth,
 * payment status and a date range on joined or last seen. The A-Z bar
 * narrows to names starting with one letter ("#" for anything else) and
 * greys out letters with no one under the other filters. Name, Joined and
 * Last seen sort from their column headers.
 *
 * All of it lives in the URL (src/lib/people-query.ts): deep-linkable,
 * shareable, and the back button works. Retention-grid cell filters
 * (tenure_bucket, recency_bucket) arrive the same way from the Lifecycle
 * screen's "Show users" and show as a banner. Pagination is keyset-based
 * ("Load more"), matching the API, for every sort.
 *
 * Empty without filters is not an error state: it is a tenant whose
 * events have not started flowing, and the copy says so. Empty with
 * filters is a search miss and offers to clear them.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search, Users, SearchX } from "lucide-react";
import { useContacts } from "../contacts.js";
import type { Contact, ContactSortKey, PaymentStatus } from "../api.js";
import { Badge, type BadgeVariant } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Select } from "../components/ui/select.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { PageHeader } from "../components/page-header.js";
import { EmptyState } from "../components/empty-state.js";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../components/ui/table.js";
import { cn } from "@/lib/utils";
import {
  DATE_PRESETS,
  DATE_PRESET_LABELS,
  ENGAGEMENT_DEPTHS,
  LETTERS,
  LIFECYCLE_STATES,
  PAYMENT_STATUSES,
  clearedQuery,
  effectiveSort,
  isFiltering,
  nextSort,
  readPeopleQuery,
  toContactFilters,
  writePeopleQuery,
  type DateField,
  type DatePreset,
  type EngagementDepth,
  type PeopleQuery,
  type TenureBucket,
} from "../lib/people-query.js";

const TENURE_LABELS: Record<TenureBucket, string> = {
  new: "New",
  growing: "Growing",
  established: "Established",
  loyal: "Loyal",
};

const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  free: "Free",
  trial: "Trial",
  paid: "Paid",
  past_due: "Past due",
  cancelled: "Cancelled",
};

function stateVariant(state: Contact["lifecycle_state"]): BadgeVariant {
  switch (state) {
    case "signed_up": return "neutral";
    case "activated": return "accent";
    case "engaged": return "success";
    case "at_risk": return "warning";
    case "dormant": return "muted";
    case "churned": return "danger";
    case "resurrected": return "success";
  }
}

function depthVariant(depth: string): BadgeVariant {
  switch (depth) {
    case "power": return "accent";
    case "regular": return "success";
    case "casual": return "neutral";
    default: return "muted";
  }
}

function paymentVariant(status: string): BadgeVariant {
  switch (status) {
    case "paid": return "success";
    case "trial": return "accent";
    case "past_due": return "danger";
    default: return "neutral";
  }
}

/** Same rule as the server's name sort and letter filter. */
function displayName(c: Contact): string {
  const name = c.name?.trim();
  return name ? name : (c.email ?? c.external_id);
}

function initial(c: Contact): string {
  return displayName(c).trim().charAt(0).toUpperCase() || "?";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

function TableSkeleton() {
  return (
    <div className="divide-y divide-border border-t border-b border-border">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-6 py-3.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

function EmptyUnfiltered() {
  return (
    <EmptyState
      icon={Users}
      title="No contacts yet"
      description="Contacts are created automatically when your events start flowing: an identify call creates the person, track calls fill their timeline. Once ingestion is connected, this table fills itself."
      action={
        <Link to="/integrate">
          <Button size="sm" variant="outline">
            Connect ingestion
          </Button>
        </Link>
      }
    />
  );
}

function EmptyFiltered({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState
      icon={SearchX}
      title="No contacts match"
      description="Nothing in this workspace matches the current search and filters."
      compact
      action={
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear search and filters
        </Button>
      }
    />
  );
}

/**
 * The A-Z bar. "All" clears the letter. Letters nobody's name starts with
 * (under the other filters) are disabled; older servers send no counts, so
 * then every letter stays enabled.
 */
function LetterBar({
  value,
  counts,
  onChange,
}: {
  value: string | null;
  counts: Record<string, number> | undefined;
  onChange: (letter: string | null) => void;
}) {
  const item =
    "flex h-7 min-w-7 shrink-0 items-center justify-center rounded-sm px-1.5 font-mono text-[12px] transition-colors duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div
      role="toolbar"
      aria-label="Filter by first letter"
      className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
    >
      <button
        type="button"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        className={cn(
          item,
          "px-2 font-sans text-[13px]",
          value === null
            ? "bg-accent-soft font-semibold text-accent-text"
            : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        )}
      >
        All
      </button>
      {LETTERS.map((l) => {
        const n = counts?.[l] ?? 0;
        const empty = counts !== undefined && n === 0 && value !== l;
        const label = l === "#" ? "Other" : l.toUpperCase();
        return (
          <button
            key={l}
            type="button"
            aria-pressed={value === l}
            aria-label={
              counts === undefined
                ? `Names starting with ${label}`
                : `Names starting with ${label}: ${n.toLocaleString("en-US")}`
            }
            title={counts === undefined ? undefined : `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`}
            disabled={empty}
            onClick={() => onChange(value === l ? null : l)}
            className={cn(
              item,
              value === l
                ? "bg-accent-soft font-semibold text-accent-text"
                : empty
                  ? "cursor-default text-subtle-foreground"
                  : "text-foreground hover:bg-secondary",
            )}
          >
            {l === "#" ? "#" : l.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}

/** A column header that sorts the list; aria-sort on the cell says which way. */
function SortableHead({
  label,
  sortKey,
  active,
  order,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: ContactSortKey;
  active: boolean;
  order: "asc" | "desc";
  onSort: (key: ContactSortKey) => void;
  align?: "left" | "right";
}) {
  const Icon = !active ? ChevronsUpDown : order === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}
      className={align === "right" ? "text-right" : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm uppercase tracking-[0.06em] transition-colors duration-(--dur-fast) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active && "text-foreground",
          align === "right" && "flex-row-reverse",
        )}
      >
        {label}
        <Icon
          size={12}
          strokeWidth={2}
          aria-hidden="true"
          className={active ? "text-foreground" : "text-subtle-foreground"}
        />
      </button>
    </TableHead>
  );
}

export default function PeoplePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useMemo(() => readPeopleQuery(searchParams), [searchParams]);
  const [searchInput, setSearchInput] = useState(query.search);

  // Patches apply to the live URL, not the router's last render: two
  // changes in quick succession (pick "All", then a payment status) must
  // not resurrect the first one's old value.
  function update(patch: Partial<PeopleQuery>) {
    setSearchParams(writePeopleQuery(new URLSearchParams(window.location.search), patch), { replace: true });
  }

  // The search box writes to the URL after a pause; the URL is what the
  // list reads. A URL change from elsewhere (back button, Clear) refills it.
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== query.search.trim()) update({ search: searchInput.trim() });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);
  useEffect(() => {
    setSearchInput((current) => (current.trim() === query.search.trim() ? current : query.search));
  }, [query.search]);

  const cellFiltering = query.tenure !== null || query.recency !== null;
  const filtering = isFiltering(query);
  const sort = effectiveSort(query);

  // Date presets resolve against today in the operator's time zone, so the
  // filters change when the query does or the day turns, not every render.
  const today = new Date().toDateString();
  const filters = useMemo(
    () => toContactFilters(query, query.search.trim(), new Date()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, today],
  );

  const list = useContacts(filters);
  const contacts = useMemo(
    () => list.data?.pages.flatMap((p) => p.contacts) ?? [],
    [list.data],
  );
  const firstPage = list.data?.pages[0];
  // The server counts every match on the first page. Older servers do not,
  // so fall back to the loaded rows with "+" while more pages exist.
  const total = firstPage?.total;
  const countLabel =
    total !== undefined
      ? total.toLocaleString("en-US")
      : `${contacts.length}${list.hasNextPage ? "+" : ""}`;
  const count = total ?? contacts.length;

  function clearFilters() {
    setSearchInput("");
    setSearchParams(clearedQuery(new URLSearchParams(window.location.search)), { replace: true });
  }

  function clearCellFilter() {
    update({ tenure: null, recency: null });
  }

  function onSort(key: ContactSortKey) {
    update(nextSort(query, key));
  }

  function onDatePreset(value: DatePreset | "") {
    if (value === "") update({ datePreset: null, dateFrom: null, dateTo: null });
    else if (value === "custom") update({ datePreset: "custom" });
    else update({ datePreset: value, dateFrom: null, dateTo: null });
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Contacts"
        title="People"
        subtitle={
          list.isLoading
            ? "Every contact your events have created."
            : filtering
              ? `${countLabel} ${count === 1 ? "match" : "matches"}`
              : count === 0
                ? "Every contact your events have created."
                : `${countLabel} ${count === 1 ? "contact" : "contacts"}`
        }
      />

      {/* Wayfinding banner: arriving from the retention grid with a cell
          filter must not look like the plain People screen. */}
      {cellFiltering && (
        <div
          role="status"
          className="animate-rise-in mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-accent-soft px-4 py-3"
        >
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-text">
              From the retention grid
            </p>
            <p className="mt-0.5 text-[14px] text-foreground">
              Showing the cell{" "}
              <span className="font-semibold">
                {query.tenure ? TENURE_LABELS[query.tenure] : "Any tenure"} ·{" "}
                <span className="capitalize">{query.recency ?? "any recency"}</span>
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/lifecycle"
              className="text-[13px] text-accent-text underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Back to Lifecycle
            </Link>
            <Button variant="outline" size="sm" onClick={clearCellFilter}>
              Clear filter
            </Button>
          </div>
        </div>
      )}

      {/* Toolbar: separated from the data by a hairline, so controls read
          as chrome and the table reads as content. */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Search contacts"
            placeholder="Search email, name, or user id"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="w-[calc(50%-6px)] sm:w-40">
          <Select
            aria-label="Filter by lifecycle state"
            value={query.state ?? ""}
            onChange={(e) => update({ state: (e.target.value || null) as Contact["lifecycle_state"] | null })}
          >
            <option value="">All states</option>
            {LIFECYCLE_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </div>
        <div className="w-[calc(50%-6px)] sm:w-36">
          <Select
            aria-label="Filter by engagement depth"
            value={query.depth ?? ""}
            onChange={(e) => update({ depth: (e.target.value || null) as EngagementDepth | null })}
          >
            <option value="">Any depth</option>
            {ENGAGEMENT_DEPTHS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </Select>
        </div>
        <div className="w-[calc(50%-6px)] sm:w-36">
          <Select
            aria-label="Filter by payment status"
            value={query.payment ?? ""}
            onChange={(e) => update({ payment: (e.target.value || null) as PaymentStatus | null })}
          >
            <option value="">Any payment</option>
            {PAYMENT_STATUSES.map((p) => (
              <option key={p} value={p}>{PAYMENT_LABELS[p]}</option>
            ))}
          </Select>
        </div>
        <div className="w-[calc(50%-6px)] sm:w-32">
          <Select
            aria-label="Date to filter on"
            value={query.dateField}
            onChange={(e) => update({ dateField: e.target.value as DateField })}
          >
            <option value="joined">Joined</option>
            <option value="last_seen">Last seen</option>
          </Select>
        </div>
        <div className="w-full sm:w-48">
          <Select
            aria-label="Date range"
            value={query.datePreset ?? ""}
            onChange={(e) => onDatePreset(e.target.value as DatePreset | "")}
          >
            <option value="">Any time</option>
            {DATE_PRESETS.map((p) => (
              <option key={p} value={p}>{DATE_PRESET_LABELS[p]}</option>
            ))}
          </Select>
        </div>
        {query.datePreset === "custom" && (
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="flex-1 sm:w-40 sm:flex-none">
              <Input
                type="date"
                aria-label="From date"
                value={query.dateFrom ?? ""}
                max={query.dateTo ?? undefined}
                onChange={(e) => update({ dateFrom: e.target.value || null })}
              />
            </div>
            <span className="text-[13px] text-muted-foreground" aria-hidden="true">to</span>
            <div className="flex-1 sm:w-40 sm:flex-none">
              <Input
                type="date"
                aria-label="To date"
                value={query.dateTo ?? ""}
                min={query.dateFrom ?? undefined}
                onChange={(e) => update({ dateTo: e.target.value || null })}
              />
            </div>
          </div>
        )}
      </div>

      {/* A-Z bar and Clear share the hairline row that separates the
          controls (chrome) from the table (content). */}
      <div className="mb-6 flex items-center gap-3 border-b border-border pb-3">
        <LetterBar
          value={query.letter}
          counts={firstPage?.letters}
          onChange={(letter) => update({ letter })}
        />
        {filtering && (
          <Button variant="ghost" size="sm" className="ml-auto shrink-0" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>

      {list.isLoading && <TableSkeleton />}

      {list.isError && (
        <div
          className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[15px] text-foreground">
            Failed to load contacts:{" "}
            {list.error instanceof Error ? list.error.message : "Unknown error"}
          </p>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {!list.isLoading && !list.isError && contacts.length === 0 && (
        filtering ? <EmptyFiltered onClear={clearFilters} /> : <EmptyUnfiltered />
      )}

      {contacts.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortableHead label="Name" sortKey="name" active={sort.key === "name"} order={sort.order} onSort={onSort} />
                <TableHead>Email</TableHead>
                <TableHead>Lifecycle</TableHead>
                <TableHead>Depth</TableHead>
                <TableHead>Payment</TableHead>
                <SortableHead
                  label="Joined"
                  sortKey="joined"
                  active={sort.key === "joined"}
                  order={sort.order}
                  onSort={onSort}
                  align="right"
                />
                <SortableHead
                  label="Last seen"
                  sortKey="last_seen"
                  active={sort.key === "last_seen"}
                  order={sort.order}
                  onSort={onSort}
                  align="right"
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((c) => (
                <TableRow
                  key={c.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/people/${c.id}`)}
                >
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <span
                        aria-hidden="true"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-text"
                      >
                        {initial(c)}
                      </span>
                      <span className="font-medium text-foreground">
                        {displayName(c)}
                        {c.company && (
                          <span className="ml-2 text-[14px] font-normal text-muted-foreground">
                            {c.company}
                          </span>
                        )}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-[13px] text-muted-foreground">
                    {c.email ?? "-"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={stateVariant(c.lifecycle_state)}>
                      {c.lifecycle_state}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {c.engagement_depth ? (
                      <Badge variant={depthVariant(c.engagement_depth)}>
                        {c.engagement_depth}
                      </Badge>
                    ) : (
                      <span className="text-subtle-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {c.payment_status ? (
                      <Badge variant={paymentVariant(c.payment_status)}>
                        {c.payment_status}
                      </Badge>
                    ) : (
                      <span className="text-subtle-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right font-mono text-[13px] text-muted-foreground">
                    {formatDate(c.first_seen_at ?? c.created_at)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right font-mono text-[13px] text-muted-foreground">
                    {formatLastSeen(c.last_seen_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {list.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                disabled={list.isFetchingNextPage}
                onClick={() => list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? "Loading..." : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
