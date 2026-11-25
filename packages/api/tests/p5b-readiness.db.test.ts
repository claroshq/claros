/**
 * P5b API behaviour on Postgres: archived products refuse ingestion, manual
 * flows enroll through POST /v1/flows/:ref/enroll (trigger `where` as the
 * audience), mirror-only topics, the scheduled flow class, and CSV
 * suppression imports emitting contact.suppressed.
 * Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { contacts, flows, flowMemberships, llmConfigs, tenants, topics, transportConfigs, webhookEndpoints, webhookOutbox } from "@claros/db/schema";
import { openDb, newProduct, newKey, bearer, cookieJson, dropProduct, app, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "p5b");
});

afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await pool.end();
});

describe("archived products", () => {
  it("answer 403 on track, identify and batch; unarchive resumes", async () => {
    const q = await newProduct(db, "p5b-arch");
    try {
      const key = await newKey(db, q.tenantId, "secret");
      const a = await app(db);
      await db.update(tenants).set({ archivedAt: new Date() }).where(eq(tenants.id, q.tenantId));
      for (const [url, payload] of [
        ["/v1/track", { userId: "u1", event: "x" }],
        ["/v1/identify", { userId: "u1", traits: { a: 1 } }],
        ["/v1/batch", { batch: [{ type: "track", userId: "u1", event: "x" }] }],
      ] as const) {
        const res = await a.inject({ method: "POST", url, headers: bearer(key), payload });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: "Product is archived." });
      }
      await db.update(tenants).set({ archivedAt: null }).where(eq(tenants.id, q.tenantId));
      const ok = await a.inject({ method: "POST", url: "/v1/track", headers: bearer(key), payload: { userId: "u1", event: "x" } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await dropProduct(db, q.tenantId);
    }
  });
});

describe("POST /v1/flows/:ref/enroll", () => {
  it("enrolls the trigger's audience page by page, or the listed external ids", async () => {
    const steps = [{ order: 1, action_type: "notice", delay: "0m", window_policy: "immediate", template_ref: "x" }];
    const where = { all: [{ trait: { key: "founding", op: "eq", value: true } }, { not: { lifecycle_state: "churned" } }] };
    const [f] = await db
      .insert(flows)
      .values({
        tenantId: p.tenantId, slug: "migration", name: "Migration", triggerType: "manual", triggerConfig: { where }, steps, status: "active",
        compileStatus: "ready", compiledPlan: { trigger: { type: "manual", condition: { where } }, steps }, flowClass: "critical", reentryPolicy: "once",
      })
      .returning({ id: flows.id });
    for (const [ext, founding, state] of [["a", true, "engaged"], ["b", true, "churned"], ["c", false, "engaged"], ["d", true, "dormant"]] as const) {
      await db.insert(contacts).values({ tenantId: p.tenantId, externalId: `enr-${ext}`, email: `enr-${ext}@example.com`, lifecycleState: state, properties: { founding } });
    }
    const a = await app(db);
    const key = await newKey(db, p.tenantId, "admin", ["config"]);
    const first = await a.inject({ method: "POST", url: "/v1/flows/migration/enroll", headers: bearer(key), payload: { limit: 2 } });
    expect(first.statusCode).toBe(200);
    let body = first.json();
    let enrolled = body.enrolled;
    while (body.next_cursor) {
      const next = await a.inject({ method: "POST", url: "/v1/flows/migration/enroll", headers: bearer(key), payload: { limit: 2, cursor: body.next_cursor } });
      body = next.json();
      enrolled += body.enrolled;
    }
    expect(enrolled).toBe(2);
    const members = await db.select({ ext: contacts.externalId }).from(flowMemberships).innerJoin(contacts, eq(contacts.id, flowMemberships.contactId)).where(eq(flowMemberships.flowId, f!.id));
    expect(members.map((m) => m.ext).sort()).toEqual(["enr-a", "enr-d"]);

    const byId = await a.inject({ method: "POST", url: `/v1/flows/${f!.id}/enroll`, headers: cookieJson(p.memberCookie), payload: { external_ids: ["enr-a", "enr-c", "nobody"] } });
    expect(byId.json()).toEqual({ enrolled: 0, skipped: { already_enrolled: 1, where: 1 }, not_found: ["nobody"] });

    const notManual = await db.insert(flows).values({ tenantId: p.tenantId, name: "E", triggerType: "event", triggerConfig: { event: "x" }, steps, status: "active", compileStatus: "ready", compiledPlan: { trigger: { type: "event", condition: {} }, steps } }).returning({ id: flows.id });
    const refused = await a.inject({ method: "POST", url: `/v1/flows/${notManual[0]!.id}/enroll`, headers: bearer(key), payload: {} });
    expect(refused.statusCode).toBe(422);
  });
});

describe("topics and flow classes", () => {
  it("mirror_only topics: settable, and no flow may use them", async () => {
    const a = await app(db);
    const created = await a.inject({ method: "POST", url: "/v1/topics", headers: cookieJson(p.ownerCookie), payload: { slug: "digest-mirror", name: "Digest", kind: "marketing", mirror_only: true } });
    expect(created.statusCode).toBe(201);
    const topic = created.json().topic;
    expect(topic.mirror_only).toBe(true);
    const flow = await a.inject({
      method: "POST", url: "/v1/flows", headers: cookieJson(p.memberCookie),
      payload: { name: "On mirror", trigger_type: "event", trigger_config: { event: "x" }, steps: [], topic_id: topic.id, flow_class: "scheduled" },
    });
    expect(flow.statusCode).toBe(400);
    expect(flow.json().error).toContain("mirror-only");

    const plain = await db.insert(topics).values({ tenantId: p.tenantId, slug: "used", name: "Used", kind: "lifecycle" }).returning({ id: topics.id });
    const ok = await a.inject({
      method: "POST", url: "/v1/flows", headers: cookieJson(p.memberCookie),
      payload: { name: "Scheduled", trigger_type: "event", trigger_config: { event: "x" }, steps: [], topic_id: plain[0]!.id, flow_class: "scheduled" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().flow_class).toBe("scheduled");
    const mirrorUsed = await a.inject({ method: "PATCH", url: `/v1/topics/${plain[0]!.id}`, headers: cookieJson(p.ownerCookie), payload: { mirror_only: true } });
    expect(mirrorUsed.statusCode).toBe(409);
  });
});

describe("CSV suppression import", () => {
  it("emits contact.suppressed per imported address", async () => {
    await db.insert(webhookEndpoints).values({ tenantId: p.tenantId, slug: `w-${randomUUID().slice(0, 6)}`, url: "https://hooks.example/x", events: ["contact.suppressed"] });
    const a = await app(db);
    const res = await a.inject({
      method: "POST", url: "/v1/suppressions/import", headers: { cookie: p.memberCookie, "content-type": "text/csv" },
      payload: "email\ncsv1@example.com\ncsv2@example.com\nCSV1@example.com\n",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported).toBe(2);
    const rows = await db.select().from(webhookOutbox).where(and(eq(webhookOutbox.tenantId, p.tenantId), eq(webhookOutbox.event, "contact.suppressed")));
    expect(rows.map((r) => (r.payload as { email: string }).email).sort()).toEqual(["csv1@example.com", "csv2@example.com"]);
    expect((rows[0]!.payload as { source: string }).source).toBe("csv_import");
  });
});

describe("the first product's configuration (fixture)", () => {
  it("PUT /v1/config applies it with no warnings; a second apply is an empty diff", async () => {
    process.env.ENCRYPTION_KEY ??= "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
    const fixture = JSON.parse(readFileSync(new URL("../../worker/tests/fixtures/product-config.json", import.meta.url), "utf8"));
    const q = await newProduct(db, "p5b-fixture");
    try {
      await db.insert(transportConfigs).values([
        { tenantId: q.tenantId, provider: "cloudflare", kind: "cloudflare", name: "cloudflare-send", config: {}, fromEmail: "a@send.acme-leads.example" },
        { tenantId: q.tenantId, provider: "resend", kind: "resend", name: "resend-main", config: {}, fromEmail: "a@mail.acme-leads.example" },
      ]);
      await db.insert(llmConfigs).values({ tenantId: q.tenantId, provider: "openai", config: "unused", isActive: true });
      const a = await app(db);
      const key = await newKey(db, q.tenantId, "admin", ["config"]);
      const res = await a.inject({ method: "PUT", url: "/v1/config", headers: bearer(key), payload: fixture });
      expect(res.statusCode).toBe(200);
      expect(res.json().warnings).toEqual([]);
      const again = await a.inject({ method: "PUT", url: "/v1/config", headers: bearer(key), payload: fixture });
      expect(again.json()).toMatchObject({ changes: [], warnings: [] });
      const exported = (await a.inject({ method: "GET", url: "/v1/config", headers: bearer(key) })).json();
      expect(exported.topics.find((t: { slug: string }) => t.slug === "weekly_digest").mirror_only).toBe(true);
      expect(exported.webhooks[0].batch_interval_minutes).toBe(30);
      expect(exported.settings.approvals).toEqual({ daily_digest: true });
    } finally {
      await dropProduct(db, q.tenantId);
    }
  });
});
