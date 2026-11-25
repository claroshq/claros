/**
 * Contract tests (every backend) for config as code (G2): state loading and
 * the atomic, version-guarded apply.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ConfigOp, FlowValues } from "@claros/core";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact } from "./support/worker-fixtures.js";

const NOW = new Date("2026-11-20T10:00:00Z");

function flowValues(slug: string, extra: Partial<FlowValues> = {}): FlowValues {
  return {
    slug, name: slug, description: null, status: "active", triggerType: "event", triggerConfig: { event: "x" },
    steps: [{ order: 1, action_type: "a", delay: "0m" }],
    compiledPlan: { trigger: { type: "event", condition: { event: "x" } }, steps: [{ order: 1, action_type: "a", delay: "0m" }] },
    compileStatus: "ready", promptSource: null, contentMode: "ai_drafted", approvalMode: "require", flowClass: "nurture",
    priority: 0, reentryPolicy: "cooldown", reentryCooldownDays: 30, topicId: null, ...extra,
  };
}

for (const factory of testBackends()) {
  describe(`apiConfig on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("applies ops atomically, merges settings, bumps config_version and loads the result", async () => {
      const t = await b.newTenant();
      await b.db.update(b.schema.tenants).set({ settings: { keep: 1, drop: 2 } }).where(eq(b.schema.tenants.id, t));
      const topicId = randomUUID();
      const flowId = randomUUID();
      const epId = randomUUID();
      const ops: ConfigOp[] = [
        { op: "upsertTopic", id: topicId, create: true, values: { slug: "account", name: "Account", kind: "transactional", description: null, defaultSubscribed: true, mirrorOnly: false } },
        { op: "upsertTemplate", id: randomUUID(), create: true, values: { slug: "t1", name: "T1", subject: "S", bodyHtml: "<p>b</p>", bodyText: null, category: null } },
        { op: "upsertFlow", id: flowId, create: true, values: flowValues("dunning", { topicId, flowClass: "critical" }), compile: false },
        { op: "upsertEndpoint", id: epId, create: true, values: { slug: "app", kind: "webhook", url: "http://127.0.0.1:9/h", events: ["message.sent"], enabled: true, config: null }, secret: "enc-1" },
        { op: "setSettings", patch: { links: { a: "https://a.example" }, drop: null } },
        { op: "setLocale", locale: "en" },
      ];
      const before = (await b.store.apiConfig.loadConfigState(t))!;
      expect(before.configVersion).toBe(0);
      expect(await b.store.apiConfig.applyConfigOps({ tenantId: t, ops, expectedVersion: 0, now: NOW })).toEqual({ ok: true, configVersion: 1 });
      const s = (await b.store.apiConfig.loadConfigState(t))!;
      expect(s.configVersion).toBe(1);
      expect(s.settings).toEqual({ keep: 1, links: { a: "https://a.example" } });
      expect(s.locale).toBe("en");
      expect(s.topics).toEqual([{ id: topicId, slug: "account", name: "Account", kind: "transactional", description: null, defaultSubscribed: true, mirrorOnly: false }]);
      expect(s.templates.map((x) => [x.slug, x.isActive])).toEqual([["t1", true]]);
      expect(s.flows).toEqual([expect.objectContaining({ id: flowId, slug: "dunning", status: "active", flowClass: "critical", topicId, triggerConfig: { event: "x" } })]);
      expect(s.endpoints).toEqual([{ id: epId, slug: "app", kind: "webhook", url: "http://127.0.0.1:9/h", events: ["message.sent"], enabled: true, secret: "enc-1", config: null }]);
      const [flow] = await b.db.select().from(b.schema.flows).where(eq(b.schema.flows.id, flowId));
      expect(flow).toMatchObject({ compileStatus: "ready", source: "config" });

      // Update, archive, delete in a second apply.
      const c = await insertContact(b, t);
      await b.db.insert(b.schema.contactTopics).values({ tenantId: t, contactId: c, topicId, status: "unsubscribed", updatedAt: NOW });
      const ops2: ConfigOp[] = [
        { op: "upsertEndpoint", id: epId, create: false, values: { slug: "app", kind: "webhook", url: "http://127.0.0.1:9/h2", events: ["message.sent"], enabled: false, config: null } },
        { op: "archiveFlow", id: flowId },
        { op: "deleteTopic", id: topicId },
      ];
      // Topic in use by the (archived) flow: the FK refuses, nothing is written.
      await expect(b.store.apiConfig.applyConfigOps({ tenantId: t, ops: ops2, expectedVersion: 1, now: NOW })).rejects.toThrow();
      const unchanged = (await b.store.apiConfig.loadConfigState(t))!;
      expect(unchanged.configVersion).toBe(1);
      expect(unchanged.flows[0]!.status).toBe("active");
      expect(unchanged.endpoints[0]!.url).toBe("http://127.0.0.1:9/h");

      const ops3: ConfigOp[] = [ops2[0]!, ops2[1]!, { op: "deleteEndpoint", id: epId }];
      expect(await b.store.apiConfig.applyConfigOps({ tenantId: t, ops: ops3, expectedVersion: 1, now: NOW })).toEqual({ ok: true, configVersion: 2 });
      const after = (await b.store.apiConfig.loadConfigState(t))!;
      expect(after.flows[0]).toMatchObject({ status: "archived", slug: null });
      expect(after.endpoints).toEqual([]);
    });

    it("refuses a stale version without writing; concurrent applies: exactly one wins", async () => {
      const t = await b.newTenant();
      const op = (slug: string): ConfigOp => ({ op: "upsertTopic", id: randomUUID(), create: true, values: { slug, name: slug, kind: "marketing", description: null, defaultSubscribed: true, mirrorOnly: false } });
      expect(await b.store.apiConfig.applyConfigOps({ tenantId: t, ops: [op("a")], expectedVersion: 5, now: NOW })).toEqual({ ok: false, conflict: true });
      expect((await b.store.apiConfig.loadConfigState(t))!.topics).toEqual([]);
      const results = await Promise.all([
        b.store.apiConfig.applyConfigOps({ tenantId: t, ops: [op("x")], expectedVersion: 0, now: NOW }),
        b.store.apiConfig.applyConfigOps({ tenantId: t, ops: [op("y")], expectedVersion: 0, now: NOW }),
      ]);
      expect(results.filter((r) => r.ok).length).toBe(1);
      const s = (await b.store.apiConfig.loadConfigState(t))!;
      expect(s.configVersion).toBe(1);
      expect(s.topics.length).toBe(1);
      expect(await b.store.apiConfig.loadConfigState(randomUUID())).toBeNull();
    });
  });
}
