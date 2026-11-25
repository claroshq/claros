/**
 * KB import decisions (G15), shared by the Postgres and D1 implementations:
 * which entries of an import create, update, stay unchanged or are skipped
 * because the row was edited since its last import.
 */
import type { ApiKbEntryRow, KbImportEntry } from "../areas/api-kb.js";

export type KbImportDecision =
  | { kind: "create"; entry: KbImportEntry }
  | { kind: "update"; entry: KbImportEntry; row: ApiKbEntryRow; contentChanged: boolean }
  | { kind: "unchanged" }
  | { kind: "skipped_edited"; key: string };

/** JSON equality with object keys in any order (jsonb does not keep key order). */
function stable(v: unknown): string {
  if (v === undefined || v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

function sameJson(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/** True when the row already holds the entry's values. */
export function kbRowMatches(row: ApiKbEntryRow, e: KbImportEntry): boolean {
  return (
    row.title === e.title &&
    row.content === e.content &&
    (row.contentType ?? "markdown") === e.contentType &&
    (row.category ?? null) === e.category &&
    sameJson(row.tags ?? null, e.tags) &&
    sameJson(row.data ?? null, e.data ?? null) &&
    Boolean(row.pinned) === e.pinned &&
    Boolean(row.isActive ?? true) === e.isActive &&
    (row.sourceUrl ?? null) === e.sourceUrl
  );
}

export function decideKbImport(row: ApiKbEntryRow | undefined, e: KbImportEntry, force: boolean): KbImportDecision {
  if (!row) return { kind: "create", entry: e };
  if (kbRowMatches(row, e)) return { kind: "unchanged" };
  const untouched = row.importedAt != null && row.updatedAt != null && new Date(row.updatedAt).getTime() <= new Date(row.importedAt).getTime();
  if (!untouched && !force) return { kind: "skipped_edited", key: e.externalKey };
  return { kind: "update", entry: e, row, contentChanged: row.content !== e.content || row.title !== e.title };
}
