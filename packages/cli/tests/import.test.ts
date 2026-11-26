/** `claros kb import` (G15), `claros import messages|events|lifecycle` (G21) against a fake Claros API. */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kbImport, importEvents, importLifecycle, importMessages, readItems, IMPORT_CHUNK } from "../src/import.js";
import { testEnv } from "./support/context.js";

function file(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "claros-import-"));
  const path = join(dir, "data.jsonl");
  writeFileSync(path, text);
  return path;
}

describe("claros kb import / import messages", () => {
  it("reads JSONL and JSON arrays", () => {
    expect(readItems('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(readItems('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(() => readItems('{"a":1}\nnope')).toThrow(/line 2/);
  });

  it("posts chunks with dry_run and force and sums the counts", async () => {
    const env = testEnv();
    const calls: Array<{ url: string; body: unknown[] }> = [];
    env.ctx.fetch = async (url, init) => {
      const body = JSON.parse(init!.body as string) as unknown[];
      calls.push({ url, body });
      return new Response(JSON.stringify({ created: body.length, updated: 0, unchanged: 0, skipped_edited: 0, errors: [] }), { status: 200 });
    };
    const lines = Array.from({ length: IMPORT_CHUNK + 3 }, (_, i) => JSON.stringify({ external_key: `k${i}`, title: "t", content: "c" })).join("\n");
    const code = await kbImport(env.ctx, { file: file(lines), url: "https://c.example", dryRun: true, force: true }, { CLAROS_ADMIN_KEY: "clr_ak_x" });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://c.example/v1/kb/import?dry_run=1&force=1");
    expect(calls[1]!.body).toHaveLength(3);
  });

  it("reports per-entry errors with a non-zero exit, and needs a key", async () => {
    const env = testEnv();
    env.ctx.fetch = async () => new Response(JSON.stringify({ imported: 1, duplicates: 0, errors: [{ index: 1, error: "unknown flow" }] }), { status: 200 });
    const code = await importMessages(env.ctx, { file: file('{"a":1}\n{"a":2}'), url: "https://c.example" }, { CLAROS_ADMIN_KEY: "k" });
    expect(code).toBe(1);
    expect(await importMessages(env.ctx, { file: file("{}"), url: "https://c.example" }, {})).toBe(2);
  });

  it("posts events to /v1/import/events and sums contacts_created", async () => {
    const env = testEnv();
    const urls: string[] = [];
    env.ctx.fetch = async (url, init) => {
      urls.push(url);
      const body = JSON.parse(init!.body as string) as unknown[];
      return new Response(JSON.stringify({ imported: body.length, duplicates: 0, contacts_created: 1, errors: [] }), { status: 200 });
    };
    const code = await importEvents(env.ctx, { file: file('{"a":1}\n{"a":2}'), url: "https://c.example", dryRun: true }, { CLAROS_ADMIN_KEY: "k" });
    expect(code).toBe(0);
    expect(urls).toEqual(["https://c.example/v1/import/events?dry_run=1"]);
    expect(env.logs.at(-1)).toBe("Dry run: imported 2, duplicates 0, contacts_created 1, errors 0");
  });

  it("pages the lifecycle recompute and prints the totals", async () => {
    const env = testEnv();
    const urls: string[] = [];
    const page = (next: string | null, n: number) => ({
      contacts: n, changed: n, applied: 0, skipped: 0, transitions: 2 * n,
      states_before: { signed_up: n }, states: { churned: n - 1, engaged: 1 },
      upcoming: { days: 14, to: { churned: 1 } }, grid: { "loyal/dormant": n },
      segment_flows: [{ slug: "nurture", name: "Nurture", status: "paused", matching: n - 1 }],
      next_cursor: next,
    });
    env.ctx.fetch = async (url, init) => {
      urls.push(url);
      expect(init!.body).toBeUndefined();
      return new Response(JSON.stringify(url.includes("cursor=") ? page(null, 3) : page("c-200", 200)), { status: 200 });
    };
    const code = await importLifecycle(env.ctx, { url: "https://c.example", dryRun: true }, { CLAROS_ADMIN_KEY: "k" });
    expect(code).toBe(0);
    expect(urls).toEqual([
      "https://c.example/v1/import/lifecycle?limit=200&dry_run=1",
      "https://c.example/v1/import/lifecycle?limit=200&dry_run=1&cursor=c-200",
    ]);
    expect(env.logs).toEqual([
      "Dry run: contacts 203, to change 203, applied 0, skipped 0, transitions 406",
      "States before: signed_up 203",
      "States after:  churned 201, engaged 2",
      "Next 14 days without new activity: churned 2",
      "Retention grid (tenure/recency): loyal/dormant 203",
      "Segment flow nurture (paused): 201 contacts match (before its where)",
    ]);
  });
});
