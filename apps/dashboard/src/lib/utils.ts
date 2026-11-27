/**
 * Class name merge utility.
 *
 * Combines clsx (conditional class strings) and tailwind-merge (deduplicates
 * conflicting Tailwind utility classes so the last one wins).
 */
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The type scale (index.css @theme --text-*) uses custom names. Without
 * registering them, tailwind-merge reads text-body as a color and drops it
 * when a text-foreground follows (or the other way round).
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["micro", "caption", "small", "body", "lead", "title", "heading", "headline", "display", "page"] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
