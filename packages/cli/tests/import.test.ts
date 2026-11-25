/** `claros kb import` (G15) and `claros import messages` (G21) against a fake Claros API. */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kbImport, importMessages, readItems, IMPORT_CHUNK } from "../src/import.js";
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
});
