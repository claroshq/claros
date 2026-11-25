/** POST /v1/import/messages (G21) with an admin key (scope messages). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/index.js";
import { contacts, flows } from "@claros/db/schema";
import { openDb, newProduct, newKey, bearer, dropProduct, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let key: string;
const app = () => buildApp({ db, logger: false, baseUrl: "http://localhost:3000" });

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "histimport");
  key = await newKey(db, p.tenantId, "admin", ["messages"]);
  await db.insert(contacts).values({ tenantId: p.tenantId, externalId: "u-1", email: "u1@example.com", lifecycleState: "engaged" });
  await db.insert(flows).values({ tenantId: p.tenantId, slug: "winback", name: "Winback", triggerType: "event", triggerConfig: {}, steps: [] });
});
afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await pool.end();
});

describe("POST /v1/import/messages", () => {
  it("validates, imports JSONL once and reports errors per item", async () => {
    const a = await app();
    const lines = [
      { external_id: "u-1", flow_slug: "winback", action_type: "winback", subject: "We miss you", sent_at: "2026-05-01T10:00:00Z" },
      { email: "U1@example.com", flow_slug: "winback", step_order: 2, action_type: "winback", sent_at: "2026-05-08T10:00:00Z" },
      { flow_slug: "winback", action_type: "winback", sent_at: "2026-05-08T10:00:00Z" },
      { external_id: "u-1", flow_slug: "winback", action_type: "winback", sent_at: "yesterday" },
    ].map((l) => JSON.stringify(l)).join("\n");
    const res = await a.inject({ method: "POST", url: "/v1/import/messages", headers: { ...bearer(key), "content-type": "text/plain" }, payload: lines });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ dry_run: false, imported: 2, duplicates: 0 });
    expect(body.errors.map((e: { index: number }) => e.index)).toEqual([2, 3]);
    const again = await a.inject({ method: "POST", url: "/v1/import/messages", headers: { ...bearer(key), "content-type": "text/plain" }, payload: lines });
    expect(again.json()).toMatchObject({ imported: 0, duplicates: 2 });
  });

  it.each(["application/x-ndjson", "application/jsonl", "application/x-jsonlines; charset=utf-8"])("accepts JSONL as %s", async (type) => {
    const a = await app();
    const line = JSON.stringify({ external_id: "u-1", flow_slug: "winback", action_type: "winback", sent_at: "2026-06-01T10:00:00Z" });
    const res = await a.inject({ method: "POST", url: "/v1/import/messages?dry_run=1", headers: { ...bearer(key), "content-type": type }, payload: line + "\n" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dry_run: true, errors: [] });
  });

  it("needs the messages scope", async () => {
    const other = await newKey(db, p.tenantId, "admin", ["kb"]);
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/v1/import/messages", headers: bearer(other), payload: [] });
    expect(res.statusCode).toBe(403);
  });
});
