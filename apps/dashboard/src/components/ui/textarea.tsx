/**
 * Textarea component.
 *
 * Boundary, focus ring, and disabled treatment match Input. Multi-line
 * fields get vertical resize only; horizontal resize breaks layouts.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-24 w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-[15px] text-foreground transition-[border-color,box-shadow] duration-(--dur-fast) placeholder:text-subtle-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-border disabled:bg-sunken disabled:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
