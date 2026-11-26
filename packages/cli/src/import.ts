/**
 * `claros kb import <file> [--dry-run] [--force]` (G15),
 * `claros import messages <file.jsonl> [--dry-run]` and
 * `claros import events <file.jsonl> [--dry-run]` (G21): read a JSONL
 * file (or a JSON array) and send it in chunks to POST /v1/kb/import,
 * POST /v1/import/messages or POST /v1/import/events with an admin key
 * (scope `kb`, `messages` or `events`).
 *
 * `claros import lifecycle [--dry-run] [--forecast-days <n>]`: page through
 * POST /v1/import/lifecycle (scope `events`) and print the totals.
 *
 * Where and which key: as `claros apply` (--url, CLAROS_URL or the instance
 * --name; --key or CLAROS_ADMIN_KEY).
 */
import { readFileSync } from "node:fs";
import type { Context } from "./ops.js";
import { DEFAULT_INSTANCE, loadState } from "./state.js";

export interface ImportOptions {
  file?: string;
  dryRun?: boolean;
  force?: boolean;
  url?: string;
  key?: string;
  name?: string;
}

/** Entries per request (the API accepts at most 1000). */
export const IMPORT_CHUNK = 500;

/** Parse a JSONL file (one JSON object per line) or a JSON array. */
export function readItems(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as unknown[];
  const items: unknown[] = [];
  trimmed.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      items.push(JSON.parse(line));
    } catch {
      throw new Error(`line ${i + 1}: not valid JSON`);
    }
  });
  return items;
}

function target(ctx: Context, opts: ImportOptions, env: NodeJS.ProcessEnv): { base: string; key: string } | null {
  const key = opts.key ?? env.CLAROS_ADMIN_KEY;
  if (!key) {
    ctx.io.warn("No admin key: pass --key or set CLAROS_ADMIN_KEY.");
    return null;
  }
  let base = opts.url ?? env.CLAROS_URL;
  if (!base) {
    const state = loadState(ctx.configDir, opts.name ?? DEFAULT_INSTANCE);
    if (state?.host) base = `https://${state.host}`;
  }
  if (!base) {
    ctx.io.warn("No Claros URL: pass --url, set CLAROS_URL, or deploy an instance with `npx @claroshq/claros deploy` (--name).");
    return null;
  }
  return { base: base.replace(/\/+$/, ""), key };
}

async function sendChunks(
  ctx: Context,
  opts: ImportOptions,
  env: NodeJS.ProcessEnv,
  path: string,
  counters: readonly string[],
): Promise<number> {
  if (!opts.file) {
    ctx.io.warn("Name the file to import.");
    return 2;
  }
  let items: unknown[];
  try {
    items = readItems(readFileSync(opts.file, "utf8"));
  } catch (err) {
    ctx.io.warn(`${opts.file}: ${(err as Error).message}`);
    return 2;
  }
  const t = target(ctx, opts, env);
  if (!t) return 2;
  const query = [opts.dryRun ? "dry_run=1" : "", opts.force ? "force=1" : ""].filter(Boolean).join("&");
  const totals: Record<string, number> = Object.fromEntries(counters.map((c) => [c, 0]));
  let errors = 0;
  for (let i = 0; i < items.length; i += IMPORT_CHUNK) {
    const chunk = items.slice(i, i + IMPORT_CHUNK);
    const res = await ctx.fetch(`${t.base}${path}${query ? `?${query}` : ""}`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.key}`, "content-type": "application/json" },
      body: JSON.stringify(chunk),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
      error?: string;
      errors?: Array<{ index: number; external_key?: string; error: string }>;
    };
    if (res.status !== 200) {
      ctx.io.warn(`${res.status}: ${body.error ?? "request failed"}`);
      return 1;
    }
    for (const c of counters) totals[c]! += Number(body[c] ?? 0);
    for (const e of body.errors ?? []) {
      errors++;
      ctx.io.log(`  error at entry ${i + e.index + 1}${e.external_key ? ` (${e.external_key})` : ""}: ${e.error}`);
    }
  }
  ctx.io.log(`${opts.dryRun ? "Dry run: " : ""}${counters.map((c) => `${c} ${totals[c]}`).join(", ")}, errors ${errors}`);
  return errors > 0 ? 1 : 0;
}

export function kbImport(ctx: Context, opts: ImportOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return sendChunks(ctx, opts, env, "/v1/kb/import", ["created", "updated", "unchanged", "skipped_edited"]);
}

export function importMessages(ctx: Context, opts: ImportOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return sendChunks(ctx, { ...opts, force: false }, env, "/v1/import/messages", ["imported", "duplicates"]);
}

export function importEvents(ctx: Context, opts: ImportOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return sendChunks(ctx, { ...opts, force: false }, env, "/v1/import/events", ["imported", "duplicates", "contacts_created"]);
}

interface LifecyclePage {
  contacts: number;
  changed: number;
  applied: number;
  skipped: number;
  transitions: number;
  states_before: Record<string, number>;
  states: Record<string, number>;
  upcoming: { days: number; to: Record<string, number> };
  grid: Record<string, number>;
  segment_flows: Array<{ slug: string | null; name: string; status: string; matching: number }>;
  next_cursor: string | null;
  error?: string;
}

/** Contacts per recompute request. */
export const LIFECYCLE_PAGE = 200;

export async function importLifecycle(
  ctx: Context,
  opts: ImportOptions & { forecastDays?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const t = target(ctx, opts, env);
  if (!t) return 2;
  const add = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
  };
  const total = { contacts: 0, changed: 0, applied: 0, skipped: 0, transitions: 0 };
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  const upcoming: Record<string, number> = {};
  const grid: Record<string, number> = {};
  const segments = new Map<string, { label: string; matching: number }>();
  let days = 14;
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: String(LIFECYCLE_PAGE) });
    if (opts.dryRun) query.set("dry_run", "1");
    if (opts.forecastDays) query.set("forecast_days", opts.forecastDays);
    if (cursor) query.set("cursor", cursor);
    const res = await ctx.fetch(`${t.base}/v1/import/lifecycle?${query}`, { method: "POST", headers: { authorization: `Bearer ${t.key}` } });
    const page = (await res.json().catch(() => ({}))) as LifecyclePage;
    if (res.status !== 200) {
      ctx.io.warn(`${res.status}: ${page.error ?? "request failed"}`);
      return 1;
    }
    for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += Number(page[k] ?? 0);
    add(before, page.states_before);
    add(after, page.states);
    add(upcoming, page.upcoming.to);
    add(grid, page.grid);
    days = page.upcoming.days;
    for (const f of page.segment_flows) {
      const key = f.slug ?? f.name;
      const s = segments.get(key) ?? { label: `${key} (${f.status})`, matching: 0 };
      s.matching += f.matching;
      segments.set(key, s);
    }
    cursor = page.next_cursor;
  } while (cursor);

  const list = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  ctx.io.log(
    `${opts.dryRun ? "Dry run: " : ""}contacts ${total.contacts}, to change ${total.changed}, applied ${total.applied}, ` +
      `skipped ${total.skipped}, transitions ${total.transitions}`,
  );
  ctx.io.log(`States before: ${list(before)}`);
  ctx.io.log(`States after:  ${list(after)}`);
  ctx.io.log(`Next ${days} days without new activity: ${list(upcoming)}`);
  ctx.io.log(`Retention grid (tenure/recency): ${list(grid)}`);
  for (const s of segments.values()) ctx.io.log(`Segment flow ${s.label}: ${s.matching} contacts match (before its where)`);
  if (total.skipped > 0) ctx.io.log("Skipped contacts received an event during the run; run it again.");
  return 0;
}
