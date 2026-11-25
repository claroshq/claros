/**
 * Contract tests for the P5b store methods, on every backend: audience
 * lookups, segment by lifecycle state, active (non-archived) products,
 * trigger properties on memberships, the daily LLM token usage, the budget
 * release, the approvals digest claim, scheduled-class concurrency,
 * message.failed on reap give-up, identify topic events, manual enrollment
 * lookups, archived products in ingestion auth and the drain.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { EnrollableFlow } from "@claros/core";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership, insertMessage } from "./support/worker-fixtures.js";

const now = new Date("2026-11-20T12:00:00Z");

for (const factory of testBackends()) {
  describe(`P5b store methods on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const webhook = async (tenantId: string, events: string[], config: unknown = null) => {
      const id = randomUUID();
      await b.db.insert(b.schema.webhookEndpoints).values({ id, tenantId, slug: `w-${id.slice(0, 6)}`, url: "https://hooks.example/x", events, config, enabled: true });
      return id;
    };
    const outbox = (tenantId: string) => b.db.select().from(b.schema.webhookOutbox).where(eq(b.schema.webhookOutbox.tenantId, tenantId));

    it("lookupLifecycleState is tenant scoped", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const c = await insertContact(b, t, { lifecycleState: "at_risk" });
      expect(await b.store.workerTriggerCheck.lookupLifecycleState({ tenantId: t, contactId: c })).toBe("at_risk");
      expect(await b.store.workerScanSegmentEnrollment.lookupLifecycleState({ tenantId: other, contactId: c })).toBeNull();
    });

    it("listStateContactsPage filters by states and depths, skips active members, pages by id", async () => {
      const t = await b.newTenant();
      const flowId = await insertFlow(b, t, { triggerType: "segment" });
      const a = await insertContact(b, t, { lifecycleState: "engaged", engagementDepth: "power" });
      const c2 = await insertContact(b, t, { lifecycleState: "dormant", engagementDepth: "casual" });
      await insertContact(b, t, { lifecycleState: "churned" });
      const member = await insertContact(b, t, { lifecycleState: "engaged" });
      await insertMembership(b, { tenantId: t, contactId: member, flowId });
      const q = b.store.workerScanSegmentEnrollment;
      const page = await q.listStateContactsPage({ tenantId: t, flowId, states: ["engaged", "dormant"], depths: null, afterId: null, limit: 10 });
      expect(page.map((r) => r.id).sort()).toEqual([a, c2].sort());
      const deep = await q.listStateContactsPage({ tenantId: t, flowId, states: null, depths: ["power"], afterId: null, limit: 10 });
      expect(deep.map((r) => r.id)).toEqual([a]);
      const first = await q.listStateContactsPage({ tenantId: t, flowId, states: ["engaged", "dormant"], depths: null, afterId: null, limit: 1 });
      const second = await q.listStateContactsPage({ tenantId: t, flowId, states: ["engaged", "dormant"], depths: null, afterId: first[0]!.id, limit: 10 });
      expect([...first, ...second].map((r) => r.id).sort()).toEqual([a, c2].sort());
    });

    it("listActiveTenantIds leaves archived products out; drain listing and claims skip them", async () => {
      const live = await b.newTenant();
      const archived = await b.newTenant();
      await b.db.update(b.schema.tenants).set({ archivedAt: now }).where(eq(b.schema.tenants.id, archived));
      const ids = await b.store.workerIndex.listActiveTenantIds();
      expect(ids).toContain(live);
      expect(ids).not.toContain(archived);

      for (const t of [live, archived]) {
        const c = await insertContact(b, t);
        const f = await insertFlow(b, t);
        const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
        await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, status: "approved", id: undefined });
      }
      const due = await b.store.workerDrain.listTenantsWithDueMessages(new Date(Date.now() + 60_000));
      expect(due).toContain(live);
      expect(due).not.toContain(archived);
      const [msg] = await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.tenantId, archived));
      expect(await b.store.workerDrainMessage.claimApprovedMessage(archived, msg.id, new Date())).toBeNull();
    });

    it("findActiveKeyByHash reports an archived product", async () => {
      const t = await b.newTenant();
      const keyHash = `kh-${randomUUID()}`;
      await b.store.apiIngestion.createKey({ tenantId: t, keyHash, prefix: "clr_sk_x", label: null, kind: "secret", allowedOrigins: null, scopes: null });
      expect((await b.store.apiIngestAuth.findActiveKeyByHash(keyHash))?.tenantArchived).toBe(false);
      await b.db.update(b.schema.tenants).set({ archivedAt: now }).where(eq(b.schema.tenants.id, t));
      expect((await b.store.apiIngestAuth.findActiveKeyByHash(keyHash))?.tenantArchived).toBe(true);
    });

    it("enrollment keeps trigger properties; scheduled flows run alongside a nurture membership", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t);
      const nurture = await insertFlow(b, t, { flowClass: "nurture" });
      const scheduled = await insertFlow(b, t, { flowClass: "scheduled" });
      const other = await insertFlow(b, t, { flowClass: "nurture" });
      const f = (id: string, flowClass: "nurture" | "scheduled", priority = 0): EnrollableFlow => ({
        id, tenantId: t, priority, triggerType: "event", triggerConfig: {}, flowClass, reentryPolicy: "every_time", reentryCooldownDays: 0,
      });
      const r1 = await b.store.workerEnroll.enrollContactInFlows({ contactId: c, tenantId: t, candidateFlows: [f(nurture, "nurture")], now, triggerProperties: { plan: "pro" } });
      expect(r1[0]!.enrolled).toBe(true);
      const r2 = await b.store.workerEnroll.enrollContactInFlows({ contactId: c, tenantId: t, candidateFlows: [f(scheduled, "scheduled"), f(other, "nurture")], now });
      expect(r2.map((r) => r.enrolled)).toEqual([true, false]);
      const membershipId = (r1[0] as { membershipId: string }).membershipId;
      expect(await b.store.workerContent.getMembershipTriggerProperties({ tenantId: t, membershipId })).toEqual({ plan: "pro" });
      const m2 = (r2[0] as { membershipId: string }).membershipId;
      expect(await b.store.workerContent.getMembershipTriggerProperties({ tenantId: t, membershipId: m2 })).toBeNull();
    });

    it("LLM tokens add up per product and UTC day (concurrent adds are not lost)", async () => {
      const t = await b.newTenant();
      const q = b.store.workerProviderResolver;
      expect(await q.getLlmTokens({ tenantId: t, day: "2026-11-20" })).toBe(0);
      await Promise.all([q.addLlmTokens({ tenantId: t, day: "2026-11-20", tokens: 100 }), q.addLlmTokens({ tenantId: t, day: "2026-11-20", tokens: 250 })]);
      await q.addLlmTokens({ tenantId: t, day: "2026-11-21", tokens: 7 });
      expect(await q.getLlmTokens({ tenantId: t, day: "2026-11-20" })).toBe(350);
      expect(await q.getLlmTokens({ tenantId: t, day: "2026-11-21" })).toBe(7);
    });

    it("releaseForBudget puts a generating message back with reason llm_budget (CAS)", async () => {
      const t = await b.newTenant();
      const c = await insertContact(b, t);
      const f = await insertFlow(b, t);
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
      const id = await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, status: "generating" });
      const [x, y] = await Promise.all([b.store.workerContent.releaseForBudget(id, now), b.store.workerContent.releaseForBudget(id, now)]);
      expect([x, y].filter(Boolean)).toHaveLength(1);
      const [row] = await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, id));
      expect(row.status).toBe("pending_generation");
      expect(row.statusReason).toBe("llm_budget");
      // A later claim and template completion clears the reason.
      await b.db.update(b.schema.lifecycleMessages).set({ status: "generating" }).where(eq(b.schema.lifecycleMessages.id, id));
      expect(await b.store.workerContent.completeTemplate(id, "pending_approval", { subject: "s", bodyHtml: "<p>b</p>", bodyText: "b" }, null, "r", now)).toBe(true);
      const [after] = await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, id));
      expect(after.statusReason).toBeNull();
    });

    it("claimDigest claims a (product, day) exactly once; counts and owners", async () => {
      const t = await b.newTenant();
      const q = b.store.workerApprovalsDigest;
      const claims = await Promise.all([1, 2, 3].map(() => q.claimDigest({ tenantId: t, day: "2026-11-20", now })));
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await q.claimDigest({ tenantId: t, day: "2026-11-21", now })).toBe(true);
      // A token row for the day does not block the claim.
      await b.store.workerProviderResolver.addLlmTokens({ tenantId: t, day: "2026-11-22", tokens: 5 });
      expect(await q.claimDigest({ tenantId: t, day: "2026-11-22", now })).toBe(true);
      expect(await b.store.workerProviderResolver.getLlmTokens({ tenantId: t, day: "2026-11-22" })).toBe(5);

      const c = await insertContact(b, t);
      const f = await insertFlow(b, t);
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
      await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, status: "pending_approval" });
      await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, status: "approved" });
      expect(await q.countPendingApprovals(t)).toBe(1);

      const owner = randomUUID();
      const member = randomUUID();
      await b.db.insert(b.schema.users).values({ id: owner, tenantId: t, email: `owner-${owner.slice(0, 6)}@example.com`, role: "owner" });
      await b.db.insert(b.schema.users).values({ id: member, tenantId: t, email: `member-${member.slice(0, 6)}@example.com`, role: "member" });
      await b.db.insert(b.schema.memberships).values({ userId: owner, tenantId: t, role: "owner" });
      await b.db.insert(b.schema.memberships).values({ userId: member, tenantId: t, role: "member" });
      expect(await q.listOwnerEmails(t)).toEqual([`owner-${owner.slice(0, 6)}@example.com`]);
      expect((await q.listActiveProducts()).some((p) => p.id === t)).toBe(true);
    });

    it("failStuckMessages writes message.failed for each failed message", async () => {
      const t = await b.newTenant();
      await webhook(t, ["message.failed"]);
      const c = await insertContact(b, t);
      const f = await insertFlow(b, t);
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
      const old = new Date(now.getTime() - 5 * 3_600_000);
      const id = await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, status: "sending", retryCount: 3, updatedAt: old });
      const failed = await b.store.workerReap.failStuckMessages({ stuckStatus: "sending", threshold: new Date(now.getTime() - 3_600_000), now, maxRetryCount: 3, tenantIds: [t] });
      expect(failed.map((r) => r.id)).toEqual([id]);
      const rows = await outbox(t);
      expect(rows).toHaveLength(1);
      expect(rows[0].event).toBe("message.failed");
      expect(rows[0].payload).toMatchObject({ message_id: id, reason: "reap_sending" });
    });

    it("markFailed writes its outbox entries with the transition only", async () => {
      const t = await b.newTenant();
      await webhook(t, ["message.failed"]);
      const c = await insertContact(b, t);
      const f = await insertFlow(b, t);
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
      const id = await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, status: "generating" });
      const events = { tenantId: t, outbox: [{ event: "message.failed", payload: { message_id: id } }] };
      expect(await b.store.workerContent.markFailed(id, "generating", "x", now, events)).toBe(true);
      expect(await b.store.workerContent.markFailed(id, "generating", "x", now, events)).toBe(false);
      expect(await outbox(t)).toHaveLength(1);
    });

    it("applyContactTopics emits contact.subscribed / contact.unsubscribed on changes only", async () => {
      const t = await b.newTenant();
      await webhook(t, ["contact.subscribed", "contact.unsubscribed"]);
      await b.db.insert(b.schema.topics).values({ tenantId: t, slug: "news", name: "News", kind: "marketing", defaultSubscribed: true });
      await b.db.insert(b.schema.topics).values({ tenantId: t, slug: "digest", name: "Digest", kind: "marketing", defaultSubscribed: false });
      await insertContact(b, t, { externalId: "u1", email: "u1@example.com" });
      // news default subscribed: true -> no change; digest default off: subscribe.
      await b.store.apiIngest.applyContactTopics({ tenantId: t, externalId: "u1", topics: { news: true, digest: true }, source: "identify", now });
      let rows = await outbox(t);
      expect(rows.map((r: any) => [r.event, r.payload.topic])).toEqual([["contact.subscribed", "digest"]]);
      await b.store.apiIngest.applyContactTopics({ tenantId: t, externalId: "u1", topics: { news: false, digest: true }, source: "identify", now });
      rows = await outbox(t);
      expect(rows.map((r: any) => [r.event, r.payload.topic]).sort()).toEqual([["contact.subscribed", "digest"], ["contact.unsubscribed", "news"]]);
    });

    it("pending-approval outbox rows use the endpoint's batch_interval_minutes window", async () => {
      const t = await b.newTenant();
      await webhook(t, ["message.pending_approval"], { batch_interval_minutes: 60 });
      await webhook(t, ["message.pending_approval"]);
      const c = await insertContact(b, t);
      const f = await insertFlow(b, t);
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
      const id = await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, status: "generating" });
      const at = new Date("2026-11-20T12:05:00Z");
      await b.store.workerContent.completeTemplate(id, "pending_approval", { subject: "s", bodyHtml: "b", bodyText: "b" }, null, "r", at, {
        tenantId: t,
        outbox: [{ event: "message.pending_approval", payload: { message_id: id }, batched: true }],
      });
      const times = (await outbox(t)).map((r: any) => new Date(r.nextAttemptAt).toISOString()).sort();
      expect(times).toEqual(["2026-11-20T12:15:00.000Z", "2026-11-20T13:00:00.000Z"]);
    });

    it("manual enrollment lookups: contact pages and external ids", async () => {
      const t = await b.newTenant();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push(await insertContact(b, t, { externalId: `m${i}` }));
      const p1 = await b.store.apiFlows.listContactIdsPage({ tenantId: t, afterId: null, limit: 2 });
      const p2 = await b.store.apiFlows.listContactIdsPage({ tenantId: t, afterId: p1[1]!, limit: 2 });
      expect([...p1, ...p2].sort()).toEqual([...ids].sort());
      const found = await b.store.apiFlows.findContactsByExternalIds({ tenantId: t, externalIds: ["m0", "m2", "nope"] });
      expect(found.map((f) => f.externalId).sort()).toEqual(["m0", "m2"]);
    });

    it("compile lookups: KB categories and settings; drain action type", async () => {
      const t = await b.newTenant();
      await b.db.update(b.schema.tenants).set({ settings: { links: { a: "https://x.example" } } }).where(eq(b.schema.tenants.id, t));
      await b.db.insert(b.schema.kbEntries).values({ tenantId: t, title: "A", content: "a", category: "tip", isActive: true });
      await b.db.insert(b.schema.kbEntries).values({ tenantId: t, title: "B", content: "b", category: "feature", isActive: true });
      await b.db.insert(b.schema.kbEntries).values({ tenantId: t, title: "C", content: "c", category: "old", isActive: false });
      expect(await b.store.workerCompile.listActiveKbCategories(t)).toEqual(["feature", "tip"]);
      expect(await b.store.workerCompile.getTenantSettings(t)).toEqual({ links: { a: "https://x.example" } });

      const c = await insertContact(b, t);
      const f = await insertFlow(b, t);
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
      const id = await insertMessage(b, { tenantId: t, contactId: c, flowId: f, membershipId: m, brainActionType: "tip_trick" });
      expect(await b.store.workerDrain.getMessageActionType({ tenantId: t, messageId: id })).toBe("tip_trick");
      expect(await b.store.workerDrain.getMessageActionType({ tenantId: randomUUID(), messageId: id })).toBeNull();
    });

    it("topics carry mirror_only", async () => {
      const t = await b.newTenant();
      const row = await b.store.apiTopics.createTopic({ tenantId: t, slug: "mirror", name: "Mirror", kind: "marketing", description: null, defaultSubscribed: false, mirrorOnly: true });
      expect(row?.mirrorOnly).toBe(true);
      const upd = await b.store.apiTopics.updateTopic({ tenantId: t, id: row!.id, patch: { mirrorOnly: false } });
      expect(upd?.mirrorOnly).toBe(false);
      void and;
    });
  });
}
