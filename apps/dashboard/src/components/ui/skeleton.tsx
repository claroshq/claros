/**
 * Skeleton loading placeholder component.
 *
 * A neutral raised surface with a slow opacity pulse. The old version used
 * the brand accent at low opacity, which made every loading screen shimmer
 * in the brand color: a loading state is absence of content, not a brand
 * moment.
 */
import { cn } from "@/lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-skeleton", className)}
      {...props}
    />
  );
}

export { Skeleton };
