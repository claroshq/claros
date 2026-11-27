/**
 * Select component.
 *
 * A styled native <select>. No custom listbox: the platform popup is more
 * accessible and more familiar than anything built from divs. The chevron
 * is decorative; the boundary, focus ring, and disabled treatment match
 * Input exactly so a form reads as one system.
 *
 * Width classes (w-*, max-w-*, min-w-*, with breakpoints) go on the wrapper
 * as well as the select, so the chevron stays inside a narrowed select.
 */
import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => {
  const widths = (className ?? "")
    .split(/\s+/)
    .filter((c) => /^(?:[a-z0-9]+:)*(?:w|max-w|min-w)-/.test(c))
    .join(" ");
  return (
    <div className={cn("relative", widths)}>
      <select
        ref={ref}
        className={cn(
          "flex h-9 w-full appearance-none rounded-md border border-input bg-card pl-3 pr-9 text-body text-foreground transition-[border-color,box-shadow] duration-(--dur-fast) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-border disabled:bg-sunken disabled:text-muted-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={16}
        strokeWidth={1.5}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
});
Select.displayName = "Select";

export { Select };
