/**
 * Class name merge utility.
 *
 * Combines clsx (conditional class strings) and tailwind-merge (deduplicates
 * conflicting Tailwind utility classes so the last one wins).
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
