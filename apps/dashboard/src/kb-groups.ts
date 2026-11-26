/**
 * Knowledge base list grouping: one section per category.
 */
import type { KbEntryPreview } from "./api.js";

export const UNCATEGORIZED = "Uncategorized";

export interface EntryGroup {
  name: string;
  entries: KbEntryPreview[];
}

/**
 * Group by category, keeping the server's order inside a group but lifting
 * pinned entries to the top. Named categories sort alphabetically;
 * uncategorized entries come last. With no categories at all, one unnamed
 * group (no header).
 */
export function groupEntries(entries: KbEntryPreview[]): EntryGroup[] {
  const byName = new Map<string, KbEntryPreview[]>();
  for (const e of entries) {
    const name = e.category?.trim() || UNCATEGORIZED;
    const list = byName.get(name);
    if (list) list.push(e);
    else byName.set(name, [e]);
  }
  const names = [...byName.keys()].sort((a, b) => {
    if (a === UNCATEGORIZED) return 1;
    if (b === UNCATEGORIZED) return -1;
    return a.localeCompare(b);
  });
  return names.map((name) => ({
    name,
    entries: [...byName.get(name)!].sort(
      (a, b) => Number(b.pinned === true) - Number(a.pinned === true),
    ),
  }));
}
