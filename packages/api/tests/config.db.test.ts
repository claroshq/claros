/**
 * G2 config as code over HTTP: dry run, apply, idempotence, prune, errors,
 * secrets, transport routing by name, analytics sink, scopes, export.
 * Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { flows, tenants, transportConfigs, webhookEndpoints } from "@claros/db/schema";
import { buildApp } from "../src/index.js";
import { decrypt, parseEncryptionKey } from "@claros/adapters";
import { openDb, newProduct, newKey, bearer, cookieJson, dropProduct, type TestDb, type TestProduct } from "./support/product.js";

const ENCRYPTION_KEY = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="; // tests only
let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let key: string;
let savedKey: string | undefined;
const jobs: Array<{ queue: string; data: Record<string, unknown> }> = [];

const app = () => buildApp({ db, logger: false, baseUrl: "http://localhost:3000", enqueue: async (queue: string, data: Record<string, unknown>) => { jobs.push({ queue, data }); return null; } });

const doc = {
  settings: {
    locale: "en",
    links: { icp_url: "https://app.fundup.example/icp" },
    link_tracking: { domains: ["fundup.example"], params: { utm_source: "claros", utm_campaign: "{{flow.slug}}" }, click_id: true },
    brain: { guidelines: "Be brief." },
    analytics: { sink: "statsraven", endpoint: "http://127.0.0.1:9", secret: "sr-ingest-token" },
  },
  topics: [
    { slug: "account", name: "Account", kind: "transactional" },
    { slug: "lifecycle", name: "Lifecycle", kind: "lifecycle" },
  ],
  templates: [{ slug: "dunning-1", name: "Dunning 1", subject: "Payment failed", body_html: "<p>Update your card</p>" }],
  transports: { routing: { default: "main" } },
  flows: [
    {
      slug: "dunning", name: "Dunning", flow_class: "critical", approval_mode: "auto", topic: "account",
      trigger: { type: "event", event: "payment_failed" },
      steps: [{ order: 1, action_type: "dunning", delay: "0m", window_policy: "immediate", template_ref: "dunning-1" }],
      exit_conditions: [{ event: "payment_succeeded" }],
    },
    {
      slug: "subscribe-nudge", name: "Subscribe nudge", topic: "lifecycle",
      trigger: { type: "event", event: "pricing_viewed", where: [{ trait: { key: "plan_tier", op: "eq", value: "free" } }] },
      prompt: "Nudge free users who viewed pricing to subscribe.",
    },
  ],
  webhooks: [{ slug: "app", url: "http://127.0.0.1:9/claros/webhook", events: ["message.pending_approval", "contact.unsubscribed"] }],
};

beforeAll(async () => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  ({ pool, db } = openDb());
  p = await newProduct(db, "config");
  key = await newKey(db, p.tenantId, "admin", ["config"]);
  await db.insert(transportConfigs).values({ tenantId: p.tenantId, provider: "resend", kind: "resend", name: "main", config: "x", fromEmail: "a@example.com" });
});

afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await pool.end();
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
});

describe("PUT /v1/config", () => {
  it("dry run lists the changes and writes nothing", async () => {
    const a = await app();
    const res = await a.inject({ method: "PUT", url: "/v1/config?dry_run=1", headers: bearer(key), payload: doc });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dry_run).toBe(true);
    expect(body.config_version).toBe(0);
    expect(body.changes.map((c: { kind: string; key: string; action: string }) => `${c.kind}:${c.key}:${c.action}`)).toEqual([
      "setting:links:create", "setting:link_tracking:create", "setting:brain:create", "setting:locale:create",
      "routing:transport_routing:create", "topic:account:create", "topic:lifecycle:create", "template:dunning-1:create",
      "flow:dunning:create", "flow:subscribe-nudge:create", "webhook:app:create", "analytics:analytics:create",
    ]);
    expect(await db.select().from(flows).where(eq(flows.tenantId, p.tenantId))).toEqual([]);
  });

  it("applies, returns the generated webhook secret once, enqueues compiles; the same document again is an empty diff", async () => {
    const a = await app();
    jobs.length = 0;
    const res = await a.inject({ method: "PUT", url: "/v1/config", headers: bearer(key), payload: doc });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.config_version).toBe(1);
    expect(body.webhook_secrets.app).toMatch(/^whsec_/);
    const fl = await db.select().from(flows).where(eq(flows.tenantId, p.tenantId));
    const nudge = fl.find((f) => f.slug === "subscribe-nudge")!;
    expect(jobs).toEqual([{ queue: "claros.compile", data: { flow_id: nudge.id, tenant_id: p.tenantId } }]);
    const dunning = fl.find((f) => f.slug === "dunning")!;
    expect(dunning).toMatchObject({ status: "active", flowClass: "critical", approvalMode: "auto", contentMode: "fixed_content", compileStatus: "ready" });
    expect(nudge.triggerConfig).toEqual({ event: "pricing_viewed", where: [{ trait: { key: "plan_tier", op: "eq", value: "free" } }] });
    const eps = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, p.tenantId));
    const hook = eps.find((e) => e.slug === "app")!;
    expect(decrypt(hook.secret!, parseEncryptionKey(ENCRYPTION_KEY))).toBe(body.webhook_secrets.app);
    const analytics = eps.find((e) => e.kind === "analytics")!;
    expect(analytics).toMatchObject({ slug: "analytics", url: "http://127.0.0.1:9", config: { sink: "statsraven" } });
    expect(decrypt(analytics.secret!, parseEncryptionKey(ENCRYPTION_KEY))).toBe("sr-ingest-token");
    const [t] = await db.select().from(tenants).where(eq(tenants.id, p.tenantId));
    expect(t!.locale).toBe("en");
    expect((t!.settings as Record<string, unknown>).transport_routing).toEqual({ default: expect.any(String) });

    const again = await a.inject({ method: "PUT", url: "/v1/config", headers: bearer(key), payload: doc });
    expect(again.json()).toEqual({ dry_run: false, changes: [], config_version: 1 });
  });

  it("updates one field, prunes on request, reports errors without writing", async () => {
    const a = await app();
    const changed = { ...doc, flows: [{ ...doc.flows[0]!, name: "Dunning v2" }, doc.flows[1]!] };
    const res = await a.inject({ method: "PUT", url: "/v1/config", headers: bearer(key), payload: changed });
    expect(res.json().changes).toEqual([{ kind: "flow", key: "dunning", action: "update", fields: ["name"] }]);
    expect(res.json().config_version).toBe(2);

    const bad = await a.inject({
      method: "PUT", url: "/v1/config", headers: bearer(key),
      payload: { flows: [{ slug: "x", name: "X", topic: "missing", trigger: { type: "manual" }, steps: [{ order: 1, action_type: "a", delay: "0m" }] }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors).toEqual(["flows.x: unknown topic 'missing'"]);
    expect((await a.inject({ method: "PUT", url: "/v1/config", headers: bearer(key), payload: { flows: [{ slug: "Bad Slug" }] } })).statusCode).toBe(400);

    const pruned = await a.inject({ method: "PUT", url: "/v1/config", headers: bearer(key), payload: { prune: true, flows: [changed.flows[0]], webhooks: [] } });
    expect(pruned.statusCode).toBe(200);
    expect(pruned.json().changes.map((c: { kind: string; key: string; action: string }) => `${c.kind}:${c.key}:${c.action}`)).toEqual([
      "flow:subscribe-nudge:archive", "webhook:app:delete",
    ]);
    const fl = await db.select().from(flows).where(eq(flows.tenantId, p.tenantId));
    expect(fl.filter((f) => f.status === "archived").length).toBe(1);
  });

  it("needs the config scope or an owner session; GET exports the document", async () => {
    const a = await app();
    const other = await newKey(db, p.tenantId, "admin", ["messages"]);
    expect((await a.inject({ method: "PUT", url: "/v1/config?dry_run=1", headers: bearer(other), payload: {} })).statusCode).toBe(403);
    expect((await a.inject({ method: "PUT", url: "/v1/config?dry_run=1", headers: cookieJson(p.memberCookie), payload: {} })).statusCode).toBe(403);
    expect((await a.inject({ method: "PUT", url: "/v1/config?dry_run=1", headers: cookieJson(p.ownerCookie), payload: {} })).statusCode).toBe(200);
    const exported = await a.inject({ method: "GET", url: "/v1/config", headers: { authorization: `Bearer ${key}` } });
    expect(exported.statusCode).toBe(200);
    const body = exported.json();
    expect(body.settings.analytics).toEqual({ sink: "statsraven", endpoint: "http://127.0.0.1:9" });
    expect(body.transports).toEqual({ routing: { default: "main" } });
    expect(body.flows.map((f: { slug: string }) => f.slug)).toEqual(["dunning"]);
    // Applying the export changes nothing it describes.
    const reapply = await a.inject({ method: "PUT", url: "/v1/config?dry_run=1", headers: bearer(key), payload: body });
    expect(reapply.json().changes).toEqual([]);
  });
});
