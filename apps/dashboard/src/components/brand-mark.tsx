/**
 * BrandMark component.
 *
 * The Claros mark: a solid droplet pointing right with a circular cutout.
 * The droplet is movement through a system; the cutout is the contact
 * passing through it. Derived from the heritage logo's interlocked drops.
 *
 * Geometry (viewBox 0 0 24 24):
 *   - Droplet: tip at (0, -10.8), body circle radius 7.8 centered at
 *     (0, 1.6), rotated 90 degrees about (12, 12) so the tip points right.
 *   - Cutout: circle radius 3.7 centered at (0, -2.4), subtracted via
 *     fill-rule="evenodd". The small cutout keeps the ring thick so the
 *     mark reads solid and full.
 *
 * Color is inherited via currentColor. Set a text color on the element or a
 * parent (e.g. text-accent) to paint it. Never hardcode a color here.
 *
 * The size prop accepts any CSS length string ("18px", "1em") or a number
 * (treated as px). Aspect ratio is always 1:1.
 *
 * Lockup rules (with the Quicksand wordmark): gap = mark size x 0.09;
 * the mark is nudged down by mark size x 0.05 to sit on the x-height
 * optical center; mark size is roughly wordmark size x 1.15 (solid fill
 * reads heavier than the wordmark strokes, so it stays smaller).
 */
interface BrandMarkProps {
  /** Width and height. CSS length string or number (px). Default 18px. */
  size?: number | string;
  className?: string;
}

export function BrandMark({ size = 18, className }: BrandMarkProps) {
  const dim = typeof size === "number" ? `${size}px` : size;
  return (
    <svg
      width={dim}
      height={dim}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <g transform="translate(12 12) rotate(90)">
        <path
          d="M0 -10.8 C0 -10.8 -7.8 -2.5 -7.8 1.6 a7.8 7.8 0 0 0 15.6 0 C7.8 -2.5 0 -10.8 0 -10.8 Z M0 -2.4 a3.7 3.7 0 1 0 0.001 0 Z"
          fill="currentColor"
          fillRule="evenodd"
        />
      </g>
    </svg>
  );
}
