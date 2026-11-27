/**
 * Input component.
 *
 * Text fields sit on the page background with a --border-strong boundary
 * (3:1 against the page, the WCAG 1.4.11 floor for control boundaries).
 * Focus replaces the boundary with a 2px ring in --ring; the border never
 * disappears without a replacement.
 *
 * Placeholder text uses --fg-subtle, which is advisory-level contrast by
 * design: placeholders are hints, never labels. Labels live outside the
 * input.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = "text", ...props }, ref) => {
  return (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-card px-3 text-[16px] text-foreground transition-[border-color,box-shadow] duration-(--dur-fast) placeholder:text-subtle-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-border disabled:bg-sunken disabled:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
