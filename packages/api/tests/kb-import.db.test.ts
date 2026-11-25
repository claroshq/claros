/** POST /v1/kb/import (G15) with an admin key (scope kb). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/index.js";
import { openDb, newProduct, newKey, bearer, dropProduct, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let key: string;
const jobs: Array<{ queue: string; data: Record<string, unknown> }> = [];
const app = () => buildApp({ db, logger: false, baseUrl: "http://localhost:3000", enqueue: async (queue: string, data: Record<string, unknown>) => { jobs.push({ queue, data }); return null; } });

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "kbimport");
  key = await newKey(db, p.tenantId, "admin", ["kb"]);
});
afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await pool.end();
});

describe("POST /v1/kb/import", () => {
  const entries = [
    { external_key: "fundup:kb:1", title: "Saved searches", content: "Save a search.", category: "tip_trick", tags: ["pro"], data: { core_insight: "x" } },
    { external_key: "fundup:kb:product_facts", title: "Product facts", content: "Facts.", category: "facts", pinned: true, active: true },
  ];

  it("dry-runs, imports, re-runs as unchanged, reports bad entries and enqueues embeddings", async () => {
    const a = await app();
    const dry = await a.inject({ method: "POST", url: "/v1/kb/import?dry_run=1", headers: bearer(key), payload: entries });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ dry_run: true, created: 2 });
    const list0 = await a.inject({ method: "GET", url: "/v1/kb", headers: bearer(key) });
    expect(list0.json().entries).toHaveLength(0);

    const res = await a.inject({ method: "POST", url: "/v1/kb/import", headers: bearer(key), payload: [...entries, { external_key: "bad" }, entries[0]] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ dry_run: false, created: 2, updated: 0, unchanged: 0, skipped_edited: 0 });
    expect(body.errors.map((e: { index: number }) => e.index)).toEqual([2, 3]);
    expect(jobs.filter((j) => j.queue.includes("kb"))).toHaveLength(2);

    const jsonl = entries.map((e) => JSON.stringify(e)).join("\n");
    const again = await a.inject({ method: "POST", url: "/v1/kb/import", headers: { ...bearer(key), "content-type": "text/plain" }, payload: jsonl });
    expect(again.json()).toMatchObject({ created: 0, unchanged: 2 });

    const list = await a.inject({ method: "GET", url: "/v1/kb", headers: bearer(key) });
    const facts = list.json().entries.find((e: { external_key: string }) => e.external_key === "fundup:kb:product_facts");
    expect(facts).toMatchObject({ category: "facts", pinned: true, source: "import" });
  });

  it.each(["application/x-ndjson", "application/jsonl", "application/x-jsonlines; charset=utf-8"])("accepts JSONL as %s", async (type) => {
    const a = await app();
    const jsonl = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const res = await a.inject({ method: "POST", url: "/v1/kb/import?dry_run=1", headers: { ...bearer(key), "content-type": type }, payload: jsonl });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dry_run: true, errors: [] });
  });

  it("rejects other media types with 415", async () => {
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/v1/kb/import?dry_run=1", headers: { ...bearer(key), "content-type": "text/csv" }, payload: "a,b" });
    expect(res.statusCode).toBe(415);
  });

  it("needs the kb scope", async () => {
    const other = await newKey(db, p.tenantId, "admin", ["config"]);
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/v1/kb/import", headers: bearer(other), payload: entries });
    expect(res.statusCode).toBe(403);
  });
});
