/**
 * /v1/webhooks: list, create (secret once, encrypted at rest), duplicate
 * slug, patch (batch interval kept in config), rotate, deliveries, delete,
 * the read-only analytics sink, auth (owner or admin key with `config`),
 * and the config_version bump. Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { tenants, webhookEndpoints, webhookOutbox } from "@claros/db/schema";
import { decrypt, parseEncryptionKey } from "@claros/adapters";
import { openDb, newProduct, newKey, bearer, cookieJson, dropProduct, app, type TestDb, type TestProduct } from "./support/product.js";

const ENCRYPTION_KEY = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="; // tests only
let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let configKey: string;
let otherKey: string;
let savedKey: string | undefined;

beforeAll(async () => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  ({ pool, db } = openDb());
  p = await newProduct(db, "webhooks");
  configKey = await newKey(db, p.tenantId, "admin", ["config"]);
  otherKey = await newKey(db, p.tenantId, "admin", ["messages"]);
});

afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await pool.end();
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
});

const version = async () => (await db.select().from(tenants).where(eq(tenants.id, p.tenantId)))[0]!.configVersion;

describe("/v1/webhooks", () => {
  it("needs an owner session or an admin key with the config scope", async () => {
    const a = await app(db);
    expect((await a.inject({ method: "GET", url: "/v1/webhooks" })).statusCode).toBe(401);
    expect((await a.inject({ method: "GET", url: "/v1/webhooks", headers: cookieJson(p.memberCookie) })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: "/v1/webhooks", headers: bearer(otherKey) })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: "/v1/webhooks", headers: cookieJson(p.ownerCookie) })).statusCode).toBe(200);
  });

  it("creates an endpoint, returns the secret once and stores it encrypted", async () => {
    const a = await app(db);
    const v0 = await version();
    const res = await a.inject({
      method: "POST", url: "/v1/webhooks", headers: bearer(configKey),
      payload: { slug: "app", url: "https://app.example.com/hook", events: ["message.pending_approval", "contact.unsubscribed"], batch_interval_minutes: 30 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.secret).toMatch(/^whsec_/);
    expect(body).toMatchObject({ slug: "app", enabled: true, batch_interval_minutes: 30, has_secret: true, read_only: false });
    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, body.id));
    expect(row!.secret).not.toContain(body.secret);
    expect(decrypt(row!.secret!, parseEncryptionKey(ENCRYPTION_KEY))).toBe(body.secret);
    expect(row!.config).toEqual({ batch_interval_minutes: 30 });
    expect(await version()).toBe(v0 + 1);

    const list = (await a.inject({ method: "GET", url: "/v1/webhooks", headers: bearer(configKey) })).json();
    expect(list.webhooks).toHaveLength(1);
    expect(list.webhooks[0].secret).toBeUndefined();
    expect(list.events).toContain("message.sent");

    const dup = await a.inject({ method: "POST", url: "/v1/webhooks", headers: bearer(configKey), payload: { slug: "app", url: "https://x.example.com", events: ["message.sent"] } });
    expect(dup.statusCode).toBe(409);
    const bad = await a.inject({ method: "POST", url: "/v1/webhooks", headers: bearer(configKey), payload: { slug: "b", url: "ftp://x", events: ["nope"] } });
    expect(bad.statusCode).toBe(400);
    const reserved = await a.inject({ method: "POST", url: "/v1/webhooks", headers: bearer(configKey), payload: { slug: "analytics", url: "https://x.example.com", events: ["message.sent"] } });
    expect(reserved.statusCode).toBe(400);
  });

  it("patches, rotates and lists deliveries", async () => {
    const a = await app(db);
    const patched = await a.inject({ method: "PATCH", url: "/v1/webhooks/app", headers: cookieJson(p.ownerCookie), payload: { enabled: false, batch_interval_minutes: null } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ enabled: false, batch_interval_minutes: 15 });
    expect((await a.inject({ method: "PATCH", url: "/v1/webhooks/app", headers: bearer(configKey), payload: {} })).statusCode).toBe(400);
    expect((await a.inject({ method: "PATCH", url: "/v1/webhooks/none", headers: bearer(configKey), payload: { enabled: true } })).statusCode).toBe(404);

    const [before] = await db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.tenantId, p.tenantId), eq(webhookEndpoints.slug, "app")));
    const rotated = await a.inject({ method: "POST", url: "/v1/webhooks/app/rotate", headers: { authorization: `Bearer ${configKey}` } });
    expect(rotated.statusCode).toBe(200);
    const [after] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, before!.id));
    expect(after!.secret).not.toBe(before!.secret);
    expect(decrypt(after!.secret!, parseEncryptionKey(ENCRYPTION_KEY))).toBe(rotated.json().secret);

    const now = new Date();
    await db.insert(webhookOutbox).values([
      { id: randomUUID(), tenantId: p.tenantId, endpointId: before!.id, event: "message.sent", payload: { message_id: "m1" }, status: "delivered", attempts: 1, nextAttemptAt: now, createdAt: new Date(now.getTime() - 1000), deliveredAt: now },
      { id: randomUUID(), tenantId: p.tenantId, endpointId: before!.id, event: "message.failed", payload: { message_id: "m2" }, status: "pending", attempts: 2, nextAttemptAt: now, lastError: "HTTP 500", createdAt: now },
    ]);
    const d = (await a.inject({ method: "GET", url: "/v1/webhooks/app/deliveries", headers: bearer(configKey) })).json();
    expect(d.deliveries.map((x: { event: string }) => x.event)).toEqual(["message.failed", "message.sent"]);
    expect(d.deliveries[0]).toMatchObject({ status: "pending", attempts: 2, last_error: "HTTP 500" });
  });

  it("keeps the analytics sink read-only and deletes endpoints", async () => {
    const a = await app(db);
    await db.insert(webhookEndpoints).values({ tenantId: p.tenantId, slug: "analytics", kind: "analytics", url: "https://stats.example.com", events: [], config: { sink: "statsraven" } });
    const list = (await a.inject({ method: "GET", url: "/v1/webhooks", headers: bearer(configKey) })).json();
    expect(list.webhooks.find((w: { slug: string }) => w.slug === "analytics")).toMatchObject({ kind: "analytics", read_only: true });
    expect((await a.inject({ method: "PATCH", url: "/v1/webhooks/analytics", headers: bearer(configKey), payload: { enabled: false } })).statusCode).toBe(409);
    expect((await a.inject({ method: "DELETE", url: "/v1/webhooks/analytics", headers: bearer(configKey) })).statusCode).toBe(409);
    expect((await a.inject({ method: "POST", url: "/v1/webhooks/analytics/rotate", headers: { authorization: `Bearer ${configKey}` } })).statusCode).toBe(409);

    const del = await a.inject({ method: "DELETE", url: "/v1/webhooks/app", headers: bearer(configKey) });
    expect(del.statusCode).toBe(200);
    expect((await a.inject({ method: "DELETE", url: "/v1/webhooks/app", headers: bearer(configKey) })).statusCode).toBe(404);
    const pending = await db.select().from(webhookOutbox).where(eq(webhookOutbox.tenantId, p.tenantId));
    expect(pending.map((r) => r.status)).toEqual(["delivered"]);
  });

  it("answers 503 without ENCRYPTION_KEY", async () => {
    const a = await app(db);
    delete process.env.ENCRYPTION_KEY;
    try {
      const res = await a.inject({ method: "POST", url: "/v1/webhooks", headers: bearer(configKey), payload: { slug: "nokey", url: "https://x.example.com", events: ["message.sent"] } });
      expect(res.statusCode).toBe(503);
    } finally {
      process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
    }
  });
});
