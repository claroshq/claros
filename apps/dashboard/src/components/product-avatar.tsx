/**
 * Product monogram: two letters on a tinted square, used by the product
 * picker and the sidebar switcher. Products have no list-level logo field,
 * so every product is drawn with its initials.
 */
import { productMonogram } from "../product-entry.js";
import { cn } from "@/lib/utils";

const SIZES = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-7 w-7 text-[11px]",
  md: "h-10 w-10 text-[13px]",
} as const;

const TONES = {
  accent: "bg-accent-soft text-accent-text",
  neutral: "bg-sunken text-muted-foreground",
  muted: "bg-sunken text-subtle-foreground",
} as const;

export function ProductAvatar({
  name,
  size = "md",
  tone = "neutral",
}: {
  name: string;
  size?: keyof typeof SIZES;
  tone?: keyof typeof TONES;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md font-semibold tracking-[0.04em]",
        SIZES[size],
        TONES[tone],
      )}
    >
      {productMonogram(name)}
    </span>
  );
}
