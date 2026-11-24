/**
 * BrandLockup component.
 *
 * The brand lockup: the droplet mark plus the lowercase "claros" wordmark
 * in Quicksand 700. The geometry is optically tuned, not mathematically
 * centered (see docs/BRAND.md section 11):
 *   - gap between mark and wordmark: mark size x 0.09
 *   - the mark is nudged down by mark size x 0.05 to sit on the x-height
 *     optical center of the wordmark
 *   - the wordmark is sized at mark size / 1.15 (the mark is a solid fill,
 *     so the classic 1.29 ratio made it overpower the light-stroked
 *     Quicksand wordmark)
 *
 * Appears in the sidebar and the login panel; nowhere else needs it.
 */
import { BrandMark } from "./brand-mark.js";

interface BrandLockupProps {
  /** Mark size in px. The wordmark derives from it. Default 24. */
  markSize?: number;
  className?: string;
}

export function BrandLockup({ markSize = 24, className }: BrandLockupProps) {
  const wordSize = Math.round((markSize / 1.15) * 10) / 10;
  const gap = Math.round(markSize * 0.09 * 10) / 10;
  const nudge = Math.round(markSize * 0.05 * 10) / 10;
  return (
    <span
      className={["flex items-center", className].filter(Boolean).join(" ")}
      style={{ gap: `${gap}px` }}
    >
      <span style={{ transform: `translateY(${nudge}px)`, display: "flex" }}>
        <BrandMark size={markSize} className="text-accent" />
      </span>
      <span
        className="font-brand font-bold tracking-[0.03em] text-foreground"
        style={{ fontSize: `${wordSize}px` }}
      >
        claros
      </span>
    </span>
  );
}
