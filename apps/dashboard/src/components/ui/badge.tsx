/**
 * Badge component.
 *
 * Status is signalled by a small dot plus tinted text on a soft surface.
 * Filled semantic blocks (the old traffic-light pills) are gone: in a dense
 * table they shout over the content, and every cell competing for attention
 * means no cell gets it.
 *
 * Tones and their meaning:
 *   accent  - brand emphasis, rare (key filter, current state of note)
 *   neutral - inactive but ordinary (draft)
 *   muted   - inactive and de-emphasized (archived, not compiled)
 *   success - working as intended (active, ready)
 *   warning - needs attention or in progress (paused, pending)
 *   danger  - broken (failed)
 *
 * The pulse prop animates the dot (e.g. compile pending). It animates
 * opacity only and is disabled by prefers-reduced-motion.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] font-medium",
  {
    variants: {
      variant: {
        accent: "bg-accent-soft text-accent-text",
        neutral: "bg-sunken text-muted-foreground",
        muted: "bg-sunken text-subtle-foreground",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-danger",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

const dotVariants = cva("h-1.5 w-1.5 shrink-0 rounded-full", {
  variants: {
    variant: {
      accent: "bg-accent",
      neutral: "bg-muted-foreground",
      muted: "bg-subtle-foreground",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-danger",
    },
  },
  defaultVariants: {
    variant: "neutral",
  },
});

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Animate the dot (opacity pulse) for in-progress states. */
  pulse?: boolean;
}

function Badge({ className, variant = "neutral", pulse = false, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      <span
        aria-hidden="true"
        className={cn(dotVariants({ variant }), pulse && "animate-pulse")}
      />
      {children}
    </span>
  );
}

export { Badge };
