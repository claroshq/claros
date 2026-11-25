/**
 * Contract tests for apiWebhooks (the webhooks page and /v1/webhooks) on
 * every backend: create (duplicate slug refused), list, find, update
 * (analytics endpoints refused), delete with pending deliveries, deliveries
 * newest first, and the config_version bump on every write.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

const NOW = new Date("2026-11-20T12:00:00.000Z");

for (const factory of testBackends()) {
  describe(`apiWebhooks on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const version = async (tenantId: string) =>
      (await b.db.select().from(b.schema.tenants).where(eq(b.schema.tenants.id, tenantId)))[0].configVersion as number;

    it("creates, refuses a duplicate slug, lists, finds and bumps config_version", async () => {
      const t = await b.newTenant();
      const q = b.store.apiWebhooks;
      const v0 = await version(t);
      const a = await q.createEndpoint({
        tenantId: t, slug: "app", url: "https://app.example.com/hook", events: ["message.sent"], enabled: true,
        config: { batch_interval_minutes: 30 }, secret: "ENC", now: NOW,
      });
      expect(a).toMatchObject({
        slug: "app", kind: "webhook", url: "https://app.example.com/hook", events: ["message.sent"], enabled: true,
        config: { batch_interval_minutes: 30 }, hasSecret: true,
      });
      expect(a!.createdAt).toBeInstanceOf(Date);
      expect(await version(t)).toBe(v0 + 1);
      const dup = await q.createEndpoint({ tenantId: t, slug: "app", url: "https://x.example.com", events: ["message.sent"], enabled: true, config: null, secret: "ENC", now: NOW });
      expect(dup).toBeNull();
      expect(await version(t)).toBe(v0 + 1);
      await q.createEndpoint({ tenantId: t, slug: "aaa", url: "https://y.example.com", events: ["flow.enrolled"], enabled: false, config: null, secret: "ENC", now: NOW });
      expect((await q.listEndpoints(t)).map((e) => e.slug)).toEqual(["aaa", "app"]);
      const other = await b.newTenant();
      expect(await q.listEndpoints(other)).toEqual([]);
      expect(await q.findEndpoint({ tenantId: other, slug: "app" })).toBeNull();
      expect((await q.findEndpoint({ tenantId: t, slug: "app" }))!.id).toBe(a!.id);
    });

    it("updates webhook endpoints only, rotates the secret", async () => {
      const t = await b.newTenant();
      const q = b.store.apiWebhooks;
      await q.createEndpoint({ tenantId: t, slug: "app", url: "https://a.example.com", events: ["message.sent"], enabled: true, config: null, secret: "OLD", now: NOW });
      await b.db.insert(b.schema.webhookEndpoints).values({ id: randomUUID(), tenantId: t, slug: "analytics", kind: "analytics", url: "https://s.example.com", events: [], enabled: true });
      const v = await version(t);
      const u = await q.updateEndpoint({ tenantId: t, slug: "app", patch: { enabled: false, events: ["message.failed"], secret: "NEW" }, now: NOW });
      expect(u).toMatchObject({ enabled: false, events: ["message.failed"], url: "https://a.example.com" });
      const raw = (await b.db.select().from(b.schema.webhookEndpoints).where(eq(b.schema.webhookEndpoints.id, u!.id)))[0];
      expect(raw.secret).toBe("NEW");
      expect(await version(t)).toBe(v + 1);
      expect(await q.updateEndpoint({ tenantId: t, slug: "analytics", patch: { enabled: false }, now: NOW })).toBeNull();
      expect(await q.updateEndpoint({ tenantId: t, slug: "missing", patch: { enabled: false }, now: NOW })).toBeNull();
      expect(await version(t)).toBe(v + 1);
    });

    it("lists deliveries newest first and deletes an endpoint with its pending deliveries", async () => {
      const t = await b.newTenant();
      const q = b.store.apiWebhooks;
      const ep = await q.createEndpoint({ tenantId: t, slug: "app", url: "https://a.example.com", events: ["message.sent"], enabled: true, config: null, secret: "S", now: NOW });
      const row = (event: string, status: string, ms: number) => ({
        id: randomUUID(), tenantId: t, endpointId: ep!.id, event, payload: { n: ms }, status, attempts: status === "delivered" ? 1 : 0,
        nextAttemptAt: new Date(NOW.getTime() + ms), createdAt: new Date(NOW.getTime() + ms),
      });
      await b.db.insert(b.schema.webhookOutbox).values([row("message.sent", "delivered", 1000), row("message.sent", "pending", 2000), row("message.sent", "dead", 3000)]);
      const d = await q.listDeliveries({ tenantId: t, endpointId: ep!.id, limit: 2 });
      expect(d.map((x) => x.status)).toEqual(["dead", "pending"]);
      expect(d[0]!.createdAt).toBeInstanceOf(Date);
      expect(d[0]!.payload).toEqual({ n: 3000 });
      expect(await q.listDeliveries({ tenantId: await b.newTenant(), endpointId: ep!.id, limit: 50 })).toEqual([]);

      expect(await q.deleteEndpoint({ tenantId: t, slug: "app", now: NOW })).toBe(true);
      expect(await q.deleteEndpoint({ tenantId: t, slug: "app", now: NOW })).toBe(false);
      const left = await b.db.select().from(b.schema.webhookOutbox).where(eq(b.schema.webhookOutbox.tenantId, t));
      expect(left.map((x: any) => x.status).sort()).toEqual(["dead", "delivered"]);
    });
  });
}
