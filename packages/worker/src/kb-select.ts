/**
 * Knowledge base v2 at render time (G18).
 *
 * kb_select {category, exclude_used, pick, tags_any_from_trait}:
 *   - candidates: active entries of the category; with exclude_used (the
 *     default) entries the contact already received are left out, imported
 *     history included (lifecycle_messages.kb_entry_id), so an entry is never
 *     sent twice to a contact;
 *   - tags_any_from_trait: the contact trait (a string or a list) names the
 *     tags an entry must carry one of; entries without tags are general and
 *     stay eligible; a missing or empty trait does not filter;
 *   - pick oldest_unused (default): the oldest eligible entry; best_match:
 *     the entry whose title and content share the most words with the step's
 *     instruction and action type (the same on both backends), ties to the
 *     oldest.
 *
 * Pinned entries always enter the brain context, oldest first, until the
 * character budget (PINNED_KB_MAX_CHARS) is used.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor, type WorkerContentKbEntry } from "@claros/store";
import { traitValue, type KbSelect } from "@claros/core";

type Db = NodePgDatabase<Record<string, never>>;

/** Budget for pinned entries in the drafting context (about 2,000 tokens). */
export const PINNED_KB_MAX_CHARS = 8000;

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

/** Filter by tags_any_from_trait (see the module header). */
export function filterByTraitTags(entries: WorkerContentKbEntry[], wanted: unknown): WorkerContentKbEntry[] {
  const list = (Array.isArray(wanted) ? wanted : typeof wanted === "string" ? [wanted] : []).filter((x): x is string => typeof x === "string" && x.length > 0);
  if (list.length === 0) return entries;
  const want = new Set(list.map((x) => x.toLowerCase()));
  return entries.filter((e) => !e.tags || e.tags.length === 0 || e.tags.some((t) => want.has(String(t).toLowerCase())));
}

/** Pick one entry (see the module header). */
export function pickKbEntry(entries: WorkerContentKbEntry[], pick: KbSelect["pick"], query: string): WorkerContentKbEntry | null {
  if (entries.length === 0) return null;
  if (pick !== "best_match") return entries[0]!;
  const q = words(query);
  let best = entries[0]!;
  let bestScore = -1;
  for (const e of entries) {
    const w = words(`${e.title} ${e.content}`);
    let score = 0;
    for (const x of q) if (w.has(x)) score++;
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

/** Eligible entries for a contact (after exclude_used and the trait filter). */
export async function eligibleKbEntries(
  db: Db,
  input: { tenantId: string; contactId: string; messageId: string; select: KbSelect; traits: Record<string, unknown> },
): Promise<WorkerContentKbEntry[]> {
  const excludeUsed = input.select.exclude_used ?? true;
  const rows = await storeFor(db).workerContent.listKbCandidates({
    tenantId: input.tenantId,
    category: input.select.category,
    excludeUsedBy: excludeUsed ? { contactId: input.contactId, exceptMessageId: input.messageId } : null,
  });
  return input.select.tags_any_from_trait ? filterByTraitTags(rows, traitValue(input.traits, input.select.tags_any_from_trait)) : rows;
}

/** Select the entry for a message, or null when none is eligible. */
export async function selectKbEntry(
  db: Db,
  input: { tenantId: string; contactId: string; messageId: string; select: KbSelect; traits: Record<string, unknown>; query: string },
): Promise<WorkerContentKbEntry | null> {
  return pickKbEntry(await eligibleKbEntries(db, input), input.select.pick, input.query);
}

/** The pinned entries as one context section, within the budget; undefined when there are none. */
export async function pinnedKbSection(db: Db, tenantId: string, maxChars = PINNED_KB_MAX_CHARS): Promise<string | undefined> {
  const pinned = await storeFor(db).workerContent.listPinnedKb(tenantId);
  const parts: string[] = [];
  let used = 0;
  for (const e of pinned) {
    const block = `## ${e.title}\n${e.content}`;
    if (used + block.length > maxChars) {
      if (parts.length === 0) parts.push(block.slice(0, maxChars));
      break;
    }
    parts.push(block);
    used += block.length + 2;
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** An entry as the drafting context's TOPIC section. */
export function kbEntrySection(e: WorkerContentKbEntry): string {
  return `## ${e.title}\n${e.content}`;
}
