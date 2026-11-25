/**
 * Product avatar, used by the product picker and the sidebar switcher.
 *
 * With a logo (GET /v1/products logo_url: the product's brand logo, uploaded
 * or external) it shows the image, contained on a white tile with a 1px
 * border: brand logos are made for the white of an email, so the tile stays
 * white in both themes, the same rule as rendered email content
 * (docs/BRAND.md, isolated content). Without a logo, or when the image fails
 * to load, it shows the product's two-letter monogram on a tinted square.
 */
import { useState } from "react";
import { productMonogram } from "../product-entry.js";
import { cn } from "@/lib/utils";

const SIZES = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-7 w-7 text-[11px]",
  md: "h-10 w-10 text-[13px]",
} as const;

const PADDING = { xs: "p-0.5", sm: "p-0.5", md: "p-1" } as const;

const TONES = {
  accent: "bg-accent-soft text-accent-text",
  neutral: "bg-sunken text-muted-foreground",
  muted: "bg-sunken text-subtle-foreground",
} as const;

export function ProductAvatar({
  name,
  logoUrl = null,
  size = "md",
  tone = "neutral",
}: {
  name: string;
  logoUrl?: string | null;
  size?: keyof typeof SIZES;
  tone?: keyof typeof TONES;
}) {
  // The URL that failed, so a changed logo URL gets a fresh attempt.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (logoUrl && failedUrl !== logoUrl) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-white",
          SIZES[size],
          PADDING[size],
        )}
      >
        <img
          src={logoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailedUrl(logoUrl)}
          className={cn("h-full w-full object-contain", tone === "muted" && "grayscale")}
        />
      </span>
    );
  }

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
