/**
 * Table components.
 *
 * Density rules:
 *   - Header cells are micro labels: 12px, 600, uppercase, tracked out,
 *     muted. They are furniture, not content, so they step back.
 *   - Body cells are 15px on a ~52px row rhythm (py-3.5).
 *   - Row separators are 1px --border; no zebra striping. Zebra stripes add
 *     a surface per row and still fail to outperform whitespace plus hover.
 *   - A table standing on the page canvas is framed: a white card with the
 *     1px edge and the card shadow, first and last columns inset 20px. On
 *     the grey canvas an unframed table floats. A table already inside a
 *     card passes framed={false}: no frame, columns flush with the card's
 *     own padding.
 *   - Row hover is the --bg-hover wash. Selected state uses --accent-soft.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & { framed?: boolean }
>(({ className, framed = true, ...props }, ref) => (
  <div
    className={cn(
      "relative w-full overflow-auto",
      framed && "rounded-lg border border-border bg-card shadow-card",
    )}
  >
    <table
      ref={ref}
      className={cn(
        "w-full text-[16px]",
        framed
          ? "[&_td]:first:pl-5 [&_td]:last:pr-5 [&_th]:first:pl-5 [&_th]:last:pr-5"
          : "[&_td]:first:pl-0 [&_td]:last:pr-0 [&_th]:first:pl-0 [&_th]:last:pr-0",
        className,
      )}
      {...props}
    />
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  />
));
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "border-b border-border transition-colors duration-(--dur-fast) hover:bg-hover data-[state=selected]:bg-accent-soft",
      className,
    )}
    {...props}
  />
));
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-11 px-3 text-left align-middle text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground [&:has([role=checkbox])]:pr-0",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "px-3 py-3.5 align-middle [&:has([role=checkbox])]:pr-0",
      className,
    )}
    {...props}
  />
));
TableCell.displayName = "TableCell";

export {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
};
