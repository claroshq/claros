/**
 * Knowledge base list helpers: what a row shows and what search matches.
 *
 * The list endpoint returns the first 300 characters of the raw content.
 * A row must read as prose, so markdown and HTML syntax is stripped before
 * display; the entry page still shows the source as written.
 */
import type { KbEntryPreview } from "./api.js";

/** Raw preview to one line of plain text for a list row. */
export function plainPreview(
  raw: string,
  contentType: KbEntryPreview["content_type"] = "markdown",
): string {
  let s = raw;
  if (contentType === "html") {
    s = s
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>?/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  } else if (contentType === "markdown") {
    s = s
      .replace(/```[^\n]*\n?/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)?/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)?/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
      .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, " ")
      .replace(/\|/g, " ")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
      .replace(/`([^`]*)`?/g, "$1")
      .replace(/\*\*|__/g, "");
    // Headings and list items carry no end punctuation; joined bare they
    // run together ("Saved searches Save any filter"). A line break after
    // an unpunctuated line becomes a sentence break.
    s = s
      .split(/\n+/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((l, i, all) => (i < all.length - 1 && !/[.!?:;,]$/.test(l) ? `${l}.` : l))
      .join(" ");
  }
  return s.replace(/\s+/g, " ").trim();
}

/** A category key ("feature_edu") as a heading ("Feature edu"). */
export function categoryLabel(key: string): string {
  const words = key.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (words === "") return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every whitespace-separated term must appear in the title, text, tags or category. */
export function matchesQuery(entry: KbEntryPreview, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [
    entry.title,
    entry.content_preview,
    entry.category ?? "",
    ...entry.tags,
  ]
    .join("\n")
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}
