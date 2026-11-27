/**
 * POST /v1/import/events and POST /v1/import/lifecycle (history import) on
 * Postgres: admin key scope, item validation, messageId dedup, the dry run
 * report, the recompute, and that neither route enqueues a job or creates an
 * enrollment, a message or a webhook row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { contacts, flows, flowMemberships, lifecycleMessages, lifecycleTransitions, tenants, webhookOutbox } from "@claros/db/schema";
import { openDb, newProduct, newKey, bearer, dropProduct, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let key: string;
const jobs: Array<{ queue: string; data: Record<string, unknown> }> = [];
const app = () => buildApp({ db, logger: false, baseUrl: "http://localhost:3000", enqueue: async (queue: string, data: Record<string, unknown>) => { jobs.push({ queue, data }); return null; } });
const DAY = 86_400_000;
const start = Date.now();
const ago = (d: number) => new Date(start - d * DAY).toISOString();

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "evimport");
  key = await newKey(db, p.tenantId, "admin", ["events"]);
  await db.update(tenants).set({ settings: { lifecycle: { activation_events: ["activated"], engagement_events: ["active_day", "activated"] } } }).where(eq(tenants.id, p.tenantId));
  const seed = new Date(start - 60_000);
  await db.insert(contacts).values({ tenantId: p.tenantId, externalId: "u-1", email: "u1@example.com", lifecycleState: "signed_up", firstSeenAt: seed, lastSeenAt: seed });
  await db.insert(flows).values([
    { tenantId: p.tenantId, slug: "dunning", name: "Dunning", triggerType: "event", triggerConfig: { type: "event", event: "payment_failed" }, steps: [], status: "active", approvalMode: "auto" },
    { tenantId: p.tenantId, slug: "winback", name: "Winback", triggerType: "lifecycle_transition", triggerConfig: { type: "lifecycle_transition", to: "churned" }, steps: [], status: "active", approvalMode: "auto" },
    { tenantId: p.tenantId, slug: "nurture", name: "Nurture", triggerType: "segment", triggerConfig: { type: "segment", lifecycle_states: ["dormant", "churned"] }, steps: [], status: "paused" },
  ]);
});
afterAll(async () => {
  await db.delete(lifecycleTransitions).where(eq(lifecycleTransitions.tenantId, p.tenantId));
  await dropProduct(db, p.tenantId);
  await pool.end();
});

const post = async (url: string, payload: unknown, headers = bearer(key)) => (await app()).inject({ method: "POST", url, headers, payload: payload as any });
/** The recompute takes no body (no content-type). */
const recompute = async (query: string, raw = key) => (await app()).inject({ method: "POST", url: `/v1/import/lifecycle${query}`, headers: { authorization: `Bearer ${raw}` } });

describe("POST /v1/import/events", () => {
  it("validates items, imports once and leaves lifecycle fields alone", async () => {
    const lines = [
      { external_id: "u-1", event: "signed_up", timestamp: ago(200), id: "signed_up:u-1" },
      { external_id: "u-1", event: "activated", timestamp: ago(190), id: "activated:u-1" },
      { email: "U1@example.com", event: "payment_failed", timestamp: ago(185), properties: { amount: 29 } },
      ...Array.from({ length: 10 }, (_, i) => ({ external_id: "u-1", event: "active_day", timestamp: ago(189 - i), id: `active_day:u-1:${i}` })),
      { external_id: "u-2", event: "activated", timestamp: ago(21), id: "activated:u-2" },
      { external_id: "u-2", event: "active_day", timestamp: ago(20), id: "active_day:u-2:1" },
      { external_id: "u-1", event: "active_day", timestamp: ago(-1) },
      { external_id: "u-1", event: "x", timestamp: "yesterday" },
      { event: "x", timestamp: ago(1) },
      { external_id: "u-1", type: "identify", event: "x", timestamp: ago(1) },
    ].map((l) => JSON.stringify(l)).join("\n");
    const headers = { ...bearer(key), "content-type": "application/x-ndjson" };

    const dry = await post("/v1/import/events?dry_run=1", lines, headers);
    expect(dry.json()).toMatchObject({ dry_run: true, imported: 15, duplicates: 0, contacts_created: 1 });
    const res = await post("/v1/import/events", lines, headers);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ dry_run: false, imported: 15, duplicates: 0, contacts_created: 1 });
    expect(body.errors.map((e: { index: number }) => e.index)).toEqual([15, 16, 17, 18]);
    expect(body.errors[0].error).toContain("future");
    expect((await post("/v1/import/events", lines, headers)).json()).toMatchObject({ imported: 0, duplicates: 15, contacts_created: 0 });

    const u1 = (await db.select().from(contacts).where(and(eq(contacts.tenantId, p.tenantId), eq(contacts.externalId, "u-1"))))[0]!;
    expect(u1.lifecycleState).toBe("signed_up");
    expect(u1.lastSeenAt!.getTime()).toBe(start - 60_000);
    expect(jobs).toEqual([]);
  });

  it("needs the events scope", async () => {
    const other = await newKey(db, p.tenantId, "admin", ["messages"]);
    expect((await post("/v1/import/events", [], bearer(other))).statusCode).toBe(403);
    expect((await recompute("?dry_run=1", other)).statusCode).toBe(403);
  });
});

describe("POST /v1/import/lifecycle", () => {
  it("reports in a dry run, applies the replay, and enrolls, queues and sends nothing", async () => {
    const dry = await recompute("?dry_run=1");
    expect(dry.statusCode).toBe(200);
    const d = dry.json();
    expect(d).toMatchObject({ dry_run: true, contacts: 2, changed: 2, applied: 0, skipped: 0, states_before: { signed_up: 2 }, states: { gone_quiet: 1, at_risk: 1 }, next_cursor: null });
    expect(d.upcoming).toEqual({ days: 14, to: { dormant: 1 } });
    expect(d.segment_flows).toEqual([{ slug: "nurture", name: "Nurture", status: "paused", matching: 1 }]);
    const unchanged = (await db.select().from(contacts).where(eq(contacts.tenantId, p.tenantId))).map((c) => c.lifecycleState);
    expect(unchanged).toEqual(["signed_up", "signed_up"]);

    const res = await recompute("");
    expect(res.json()).toMatchObject({ dry_run: false, changed: 2, applied: 2, skipped: 0 });
    const rows = await db.select().from(contacts).where(eq(contacts.tenantId, p.tenantId));
    const u1 = rows.find((c) => c.externalId === "u-1")!;
    expect(u1).toMatchObject({ lifecycleState: "churned" });
    expect(u1.firstSeenAt!.toISOString()).toBe(ago(200));
    expect(u1.lastSeenAt!.toISOString()).toBe(ago(180));
    expect(u1.activatedAt!.toISOString()).toBe(ago(190));
    const ts = await db.select().from(lifecycleTransitions).where(eq(lifecycleTransitions.contactId, u1.id));
    expect(ts.length).toBeGreaterThan(0);
    expect(ts.every((t) => (t.metadata as { source?: string }).source === "import")).toBe(true);

    // Paged: the same result, nothing more to change.
    const p1 = (await recompute("?limit=1")).json();
    expect(p1).toMatchObject({ contacts: 1, changed: 0 });
    expect(p1.next_cursor).toBeTruthy();
    expect((await recompute(`?limit=1&cursor=${p1.next_cursor}`)).json()).toMatchObject({ contacts: 1, changed: 0 });

    expect(jobs).toEqual([]);
    for (const t of [flowMemberships, lifecycleMessages, webhookOutbox]) {
      expect(await db.select().from(t).where(eq(t.tenantId, p.tenantId))).toEqual([]);
    }
  });
});
