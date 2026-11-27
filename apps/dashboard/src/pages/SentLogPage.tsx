/**
 * Sent-mail log page.
 *
 * A dense, scannable log of every message that left the drafting pipeline.
 * This is where an operator lives when answering "did that email send, and
 * what did it look like." Density and scannability over decoration.
 *
 * Filters: status, flow, recipient search, feedback.
 * Rows are grouped by the local day they were sent (Today, Yesterday, ...).
 * Pagination: numbered pages (?page=N in the URL, so going back from a
 * message returns to the same page). Refresh re-reads the current page.
 */
import React, { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { Search, Send, SearchX, RefreshCw } from "lucide-react";
import { PageHeader } from "../components/page-header.js";
import { Pagination } from "../components/pagination.js";
import { groupByDay } from "../day-groups.js";
import { cn } from "@/lib/utils";
import { EmptyState } from "../components/empty-state.js";
import { Badge, type BadgeVariant } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Select } from "../components/ui/select.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../components/ui/table.js";
import { useSentLog, SENT_LOG_PAGE_SIZE } from "../sent-log.js";
import { useFlows } from "../flows.js";
import type { SentLogFilters } from "../api.js";

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

function feedbackVariant(feedback: string | null): BadgeVariant {
  switch (feedback) {
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

/** Time of day; the day itself is the group heading. */
function formatTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function recipientLabel(msg: {
  recipient_address: string | null;
  contact: { email: string | null; name: string | null };
}): string {
  if (msg.contact.name) return msg.contact.name;
  if (msg.recipient_address) return msg.recipient_address;
  if (msg.contact.email) return msg.contact.email;
  return "(unknown)";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SentLogPage() {
  const navigate = useNavigate();
  const topRef = useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const rawPage = parseInt(searchParams.get("page") ?? "", 10);
  const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [flowFilter, setFlowFilter] = useState("");
  const [feedbackFilter, setFeedbackFilter] = useState("");

  // Debounce the search term; the query key carries the settled value.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const filters: SentLogFilters = useMemo(
    () => ({
      ...(statusFilter && { status: statusFilter }),
      ...(flowFilter && { flow_id: flowFilter }),
      ...(debouncedSearch && { recipient: debouncedSearch }),
      ...(feedbackFilter && { feedback: feedbackFilter }),
    }),
    [statusFilter, flowFilter, debouncedSearch, feedbackFilter],
  );

  function setPage(next: number) {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next <= 1) p.delete("page");
        else p.set("page", String(next));
        return p;
      },
      { replace: true },
    );
  }

  // A filter change starts over at page 1. Skips the first run, so a
  // ?page=N deep link (or going back from a message) keeps its page.
  const filtersKey = JSON.stringify(filters);
  const seenFilters = useRef(filtersKey);
  useEffect(() => {
    if (seenFilters.current === filtersKey) return;
    seenFilters.current = filtersKey;
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const list = useSentLog(page, filters);
  const { data: flowsData } = useFlows();
  const flows = flowsData?.flows ?? [];

  const allMessages = list.data?.messages ?? [];
  const total = list.data?.total ?? 0;
  const pageSize = list.data?.page_size ?? SENT_LOG_PAGE_SIZE;
  const hasFilters =
    statusFilter || flowFilter || debouncedSearch || feedbackFilter;
  const groups = groupByDay(allMessages, (m) => m.sent_at, "Not sent");

  // A page past the end (rows deleted, or a stale link): go to the last page.
  useEffect(() => {
    if (
      list.isSuccess &&
      !list.isPlaceholderData &&
      allMessages.length === 0 &&
      total > 0
    ) {
      setPage(Math.ceil(total / pageSize));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    list.isSuccess,
    list.isPlaceholderData,
    allMessages.length,
    total,
    pageSize,
  ]);

  function clearFilters() {
    setSearchInput("");
    setDebouncedSearch("");
    setStatusFilter("");
    setFlowFilter("");
    setFeedbackFilter("");
  }

  return (
    <div ref={topRef} className="mx-auto max-w-[90rem]">
      <PageHeader
        eyebrow="Delivery"
        title="Sent Mail"
        subtitle="Every message that left the pipeline: who received it, when, and what happened after."
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => list.refetch()}
              disabled={list.isFetching}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw className={cn(list.isFetching && "animate-spin")} />
              Refresh
            </Button>
            <Link to="/sent/suppressions">
              <Button variant="outline" size="sm">
                Suppressions
              </Button>
            </Link>
          </>
        }
      />

      {/* Toolbar: separated from the log by a hairline, so controls read
          as chrome and the table reads as content. */}
      <div className="mb-6 flex flex-wrap items-center gap-3 border-b border-border pb-5">
        <div className="relative w-full sm:w-72">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            placeholder="Search recipient..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-[calc(50%-6px)] sm:w-36"
        >
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="sending">Sending</option>
          <option value="failed">Failed</option>
          <option value="suppressed">Suppressed</option>
        </Select>
        <Select
          value={feedbackFilter}
          onChange={(e) => setFeedbackFilter(e.target.value)}
          className="w-[calc(50%-6px)] sm:w-36"
        >
          <option value="">All feedback</option>
          <option value="opened">Opened</option>
          <option value="clicked">Clicked</option>
          <option value="bounced">Bounced</option>
          <option value="complained">Complained</option>
        </Select>
        <Select
          value={flowFilter}
          onChange={(e) => setFlowFilter(e.target.value)}
          className="w-full sm:w-48"
        >
          <option value="">All flows</option>
          {flows.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear
          </Button>
        )}
      </div>

      {/* Loading */}
      {list.isLoading && <TableSkeleton />}

      {/* Error */}
      {list.isError && (
        <div
          className="flex items-center justify-between rounded-md border border-danger bg-danger-soft px-4 py-3"
          role="alert"
        >
          <p className="text-[17px] text-foreground">
            Failed to load messages:{" "}
            {list.error instanceof Error ? list.error.message : "Unknown error"}
          </p>
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {/* Empty states */}
      {list.isSuccess && total === 0 && !hasFilters && (
        <EmptyState
          icon={Send}
          title="No messages sent yet"
          description="Every message that leaves the pipeline lands here: who received it, when, and what happened after. Messages appear once they clear the approval queue."
        />
      )}
      {list.isSuccess && total === 0 && hasFilters && (
        <EmptyState
          icon={SearchX}
          title="No messages match"
          description="Nothing in the log matches the current search and filters."
          compact
          action={
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear search and filters
            </Button>
          }
        />
      )}

      {/* Table */}
      {list.isSuccess && allMessages.length > 0 && (
        <>
          <Table
            className={cn(
              "transition-opacity duration-(--dur-fast)",
              list.isPlaceholderData && "opacity-60",
            )}
          >
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Recipient</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Flow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Feedback</TableHead>
                <TableHead className="text-right">Sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <React.Fragment key={group.key}>
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={6} className="bg-sunken/60 py-2">
                      <span className="text-[15px] font-semibold text-foreground">
                        {group.label}
                      </span>
                      {group.detail && (
                        <span className="ml-2 text-[15px] text-muted-foreground">
                          {group.detail}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                  {group.rows.map((msg) => (
                    <TableRow
                      key={msg.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/sent/${msg.id}`)}
                    >
                      <TableCell className="max-w-[220px]">
                        {msg.contact.name ? (
                          <>
                            <span className="block truncate font-medium text-foreground">
                              {msg.contact.name}
                            </span>
                            <span className="block truncate font-mono text-[14px] text-muted-foreground">
                              {msg.recipient_address ?? msg.contact.email ?? ""}
                            </span>
                          </>
                        ) : (
                          <span className="block truncate font-mono text-[14px]">
                            {recipientLabel(msg)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[250px] truncate">
                        {msg.subject ?? "(no subject)"}
                      </TableCell>
                      <TableCell className="max-w-[150px] truncate">
                        {msg.flow_name ? (
                          <Link
                            to={`/flows/${msg.flow_id}/edit`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-accent-text underline-offset-4 hover:underline"
                          >
                            {msg.flow_name}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(msg.status)}>
                          {msg.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {msg.feedback ? (
                          <Badge variant={feedbackVariant(msg.feedback)}>
                            {msg.feedback}
                          </Badge>
                        ) : (
                          <span className="text-subtle-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-mono text-[14px] text-muted-foreground">
                        {formatTime(msg.sent_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>

          <Pagination
            className="mt-4"
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={(p) => {
              setPage(p);
              // The shell scrolls <main>, not the window.
              const scroller = topRef.current?.closest("main");
              if (scroller) scroller.scrollTo({ top: 0 });
              else window.scrollTo({ top: 0 });
            }}
            noun="messages"
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function TableSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex gap-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-24" />
        </div>
      ))}
    </div>
  );
}
