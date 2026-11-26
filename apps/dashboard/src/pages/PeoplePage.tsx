/**
 * People list page.
 *
 * A table people scan for a long time: 13px cells, micro-label headers,
 * 1px separators, dot badges for lifecycle state. Search matches email,
 * name and external id; filters cover lifecycle state and engagement
 * depth. Retention-grid cell filters (tenure_bucket, recency_bucket)
 * arrive via the URL from the Lifecycle screen's "Show users" and show
 * as a removable chip. Pagination is cursor-based ("Load more"),
 * matching the API.
 *
 * Empty without filters is not an error state: it is a tenant whose
 * events have not started flowing, and the copy says so. Empty with
 * filters is a search miss and offers to clear them.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Search, Users, SearchX } from "lucide-react";
import { useContacts } from "../contacts.js";
import type { Contact, ContactFilters } from "../api.js";
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

const LIFECYCLE_STATES: ReadonlyArray<Contact["lifecycle_state"]> = [
  "signed_up",
  "activated",
  "engaged",
  "at_risk",
  "dormant",
  "churned",
  "resurrected",
];

const ENGAGEMENT_DEPTHS = ["power", "regular", "casual", "minimal"] as const;

const TENURE_BUCKETS = ["new", "growing", "established", "loyal"] as const;
const RECENCY_BUCKETS = ["active", "cooling", "idle", "dormant"] as const;

type TenureBucket = (typeof TENURE_BUCKETS)[number];
type RecencyBucket = (typeof RECENCY_BUCKETS)[number];

const TENURE_LABELS: Record<TenureBucket, string> = {
  new: "New",
  growing: "Growing",
  established: "Established",
  loyal: "Loyal",
};

function isTenureBucket(v: string | null): v is TenureBucket {
  return v !== null && (TENURE_BUCKETS as readonly string[]).includes(v);
}

function isRecencyBucket(v: string | null): v is RecencyBucket {
  return v !== null && (RECENCY_BUCKETS as readonly string[]).includes(v);
}

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

function displayName(c: Contact): string {
  return c.name ?? c.email ?? c.external_id;
}

function initial(c: Contact): string {
  return displayName(c).trim().charAt(0).toUpperCase() || "?";
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
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

export default function PeoplePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<Contact["lifecycle_state"] | "">("");
  const [depth, setDepth] = useState<(typeof ENGAGEMENT_DEPTHS)[number] | "">("");

  // Retention-grid cell filters arrive via the URL (from the Lifecycle
  // screen's "Show users"). They live in the address bar, not in local
  // state: deep-linkable, shareable, and the back button works.
  const tenureParam = searchParams.get("tenure_bucket");
  const recencyParam = searchParams.get("recency_bucket");
  const tenure = isTenureBucket(tenureParam) ? tenureParam : null;
  const recency = isRecencyBucket(recencyParam) ? recencyParam : null;
  const cellFiltering = tenure !== null || recency !== null;

  // Debounce the search term; the query key carries the settled value.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filters: ContactFilters = useMemo(
    () => ({
      ...(search ? { search } : {}),
      ...(state ? { lifecycle_state: state } : {}),
      ...(depth ? { engagement_depth: depth } : {}),
      ...(tenure ? { tenure_bucket: tenure } : {}),
      ...(recency ? { recency_bucket: recency } : {}),
    }),
    [search, state, depth, tenure, recency],
  );
  const filtering = search !== "" || state !== "" || depth !== "" || cellFiltering;

  const list = useContacts(filters);
  const contacts = useMemo(
    () => list.data?.pages.flatMap((p) => p.contacts) ?? [],
    [list.data],
  );
  // The server counts every match on the first page. Older servers do not,
  // so fall back to the loaded rows with "+" while more pages exist.
  const total = list.data?.pages[0]?.total;
  const countLabel =
    total !== undefined
      ? total.toLocaleString("en-US")
      : `${contacts.length}${list.hasNextPage ? "+" : ""}`;
  const count = total ?? contacts.length;

  function clearFilters() {
    setSearchInput("");
    setSearch("");
    setState("");
    setDepth("");
    setSearchParams({}, { replace: true });
  }

  function clearCellFilter() {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("tenure_bucket");
        next.delete("recency_bucket");
        return next;
      },
      { replace: true },
    );
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
                {tenure ? TENURE_LABELS[tenure] : "Any tenure"} ·{" "}
                <span className="capitalize">{recency ?? "any recency"}</span>
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
      <div className="mb-6 flex flex-wrap items-center gap-3 border-b border-border pb-5">
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
        <div className="w-[calc(50%-6px)] sm:w-48">
          <Select
            aria-label="Filter by lifecycle state"
            value={state}
            onChange={(e) => setState(e.target.value as Contact["lifecycle_state"] | "")}
          >
            <option value="">All states</option>
            {LIFECYCLE_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </div>
        <div className="w-[calc(50%-6px)] sm:w-44">
          <Select
            aria-label="Filter by engagement depth"
            value={depth}
            onChange={(e) => setDepth(e.target.value as (typeof ENGAGEMENT_DEPTHS)[number] | "")}
          >
            <option value="">Any depth</option>
            {ENGAGEMENT_DEPTHS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </Select>
        </div>
        {filtering && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear
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
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Lifecycle</TableHead>
                <TableHead>Depth</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead className="text-right">Last seen</TableHead>
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
                  <TableCell className="text-right font-mono text-[13px] text-muted-foreground">
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
