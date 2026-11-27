/**
 * Numbered pagination: "1-50 of 312" on the left, Previous / page numbers /
 * Next on the right. Long ranges collapse to the first page, the last page
 * and the current page's neighbours, with an ellipsis between gaps.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui/button.js";
import { cn } from "@/lib/utils";

interface PaginationProps {
  /** Current page, 1-based. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Noun for the range label, plural. */
  noun?: string;
  className?: string;
}

/** The page numbers to show, with null for an ellipsis. Exported for tests. */
export function pageItems(page: number, pageCount: number): (number | null)[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const keep = new Set([1, pageCount, page - 1, page, page + 1]);
  // Near either end show five in a row, so the bar keeps a steady width.
  if (page <= 4) [2, 3, 4, 5].forEach((p) => keep.add(p));
  if (page >= pageCount - 3) [1, 2, 3, 4].forEach((d) => keep.add(pageCount - d));
  const sorted = [...keep].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (typeof prev === "number" && p - prev > 1) out.push(null);
    out.push(p);
  }
  return out;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  noun = "results",
  className,
}: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <nav
      aria-label="Pagination"
      className={cn("flex flex-wrap items-center justify-between gap-3", className)}
    >
      <p className="text-[14px] text-muted-foreground tabular-nums">
        {first.toLocaleString("en-US")}-{last.toLocaleString("en-US")} of{" "}
        {total.toLocaleString("en-US")} {noun}
      </p>
      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft />
            <span className="hidden sm:inline">Previous</span>
          </Button>
          {pageItems(page, pageCount).map((p, i) =>
            p === null ? (
              <span
                key={`gap-${i}`}
                className="w-8 text-center text-[15px] text-subtle-foreground"
                aria-hidden
              >
                ...
              </span>
            ) : (
              <Button
                key={p}
                variant={p === page ? "outline" : "ghost"}
                size="sm"
                className={cn("min-w-8 px-2 tabular-nums", p === page && "text-foreground")}
                onClick={() => onPageChange(p)}
                aria-current={p === page ? "page" : undefined}
                aria-label={`Page ${p}`}
              >
                {p}
              </Button>
            ),
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pageCount}
            aria-label="Next page"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight />
          </Button>
        </div>
      )}
    </nav>
  );
}
