/**
 * Contract tests for topics (G8a) and transports with routing (G26) on every
 * backend: apiTopics, contact topic statuses (apiContacts, apiUnsubscribe,
 * apiIngest), the drain's topic gate and per-transport writes (workerDrain),
 * transport listing and routing (workerTransportResolver, apiSettings), and
 * flows with a topic (apiFlows).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { getMessage, seedContact, seedFlow, seedMessage } from "./support/send-path-fixtures.js";

const ENVELOPE = JSON.stringify({ v: 1, iv: "abc", tag: "def", data: "ghi" });
const NOW = new Date("2026-11-20T12:00:00.000Z");

async function seedTopic(b: Backend, tenantId: string, values: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.topics).values({
    id,
    tenantId,
    slug: `topic-${id.slice(0, 8)}`,
    name: "Topic",
    kind: "marketing",
    ...values,
  });
  return id;
}

for (const factory of testBackends()) {
  describe(`topics and transports on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    // -----------------------------------------------------------------------
    // apiTopics
    // -----------------------------------------------------------------------

    describe("apiTopics", () => {
      it("creates, lists (oldest first), finds (tenant scoped) and updates topics", async () => {
        const t = await b.newTenant();
        const q = b.store.apiTopics;
        const a = await q.createTopic({
          tenantId: t, slug: "product-news", name: "Product news", kind: "marketing", description: "Monthly", defaultSubscribed: true,
        });
        expect(a).toEqual({
          id: expect.any(String),
          tenantId: t,
          slug: "product-news",
          name: "Product news",
          kind: "marketing",
          description: "Monthly",
          defaultSubscribed: true,
          mirrorOnly: false,
          createdAt: expect.any(Date),
        });
        const c = await q.createTopic({
          tenantId: t, slug: "receipts", name: "Receipts", kind: "transactional", description: null, defaultSubscribed: false,
        });
        expect((await q.listTopics(t)).map((r) => r.slug)).toEqual(["product-news", "receipts"]);
        expect(await q.findTopic({ tenantId: t, id: c!.id })).toEqual(c);
        expect(await q.findTopic({ tenantId: await b.newTenant(), id: c!.id })).toBeNull();

        const updated = await q.updateTopic({ tenantId: t, id: a!.id, patch: { name: "News", defaultSubscribed: false, description: null } });
        expect(updated).toMatchObject({ id: a!.id, slug: "product-news", name: "News", defaultSubscribed: false, description: null, kind: "marketing" });
        expect(await q.updateTopic({ tenantId: t, id: a!.id, patch: {} })).toEqual(updated);
        expect(await q.updateTopic({ tenantId: await b.newTenant(), id: a!.id, patch: { name: "X" } })).toBeNull();
      });

      it("refuses a duplicate slug in the tenant, also under concurrency; other tenants are free", async () => {
        const t = await b.newTenant();
        const input = { tenantId: t, slug: "dup", name: "Dup", kind: "lifecycle", description: null, defaultSubscribed: true };
        const results = await Promise.all([b.store.apiTopics.createTopic(input), b.store.apiTopics.createTopic(input)]);
        expect(results.filter((r) => r !== null)).toHaveLength(1);
        expect(await b.store.apiTopics.createTopic(input)).toBeNull();
        expect(await b.store.apiTopics.createTopic({ ...input, tenantId: await b.newTenant() })).not.toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    // Contact topic statuses
    // -----------------------------------------------------------------------

    describe("contact topic statuses", () => {
      it("lists every topic with the explicit status or null, and sets statuses (tenant scoped)", async () => {
        const t = await b.newTenant();
        const contactId = await seedContact(b, t);
        const news = await seedTopic(b, t, { slug: "a-news", name: "News", createdAt: new Date("2026-01-01T00:00:00Z") });
        const tips = await seedTopic(b, t, { slug: "b-tips", name: "Tips", kind: "lifecycle", defaultSubscribed: false, createdAt: new Date("2026-01-02T00:00:00Z") });
        const foreign = await seedTopic(b, await b.newTenant());

        const before = await b.store.apiContacts.listContactTopics({ tenantId: t, contactId });
        expect(before).toEqual([
          { topicId: news, slug: "a-news", name: "News", kind: "marketing", defaultSubscribed: true, status: null, source: null, updatedAt: null },
          { topicId: tips, slug: "b-tips", name: "Tips", kind: "lifecycle", defaultSubscribed: false, status: null, source: null, updatedAt: null },
        ]);

        await b.store.apiUnsubscribe.setContactTopicStatuses({
          tenantId: t,
          contactId,
          statuses: [
            { topicId: news, status: "unsubscribed" },
            { topicId: tips, status: "subscribed" },
            { topicId: foreign, status: "unsubscribed" },
          ],
          source: "page",
          now: NOW,
        });
        const after = await b.store.apiUnsubscribe.listContactTopics({ tenantId: t, contactId });
        expect(after.map((r) => [r.slug, r.status, r.source, r.updatedAt])).toEqual([
          ["a-news", "unsubscribed", "page", NOW],
          ["b-tips", "subscribed", "page", NOW],
        ]);
        const rows = await b.db.select().from(b.schema.contactTopics).where(eq(b.schema.contactTopics.contactId, contactId));
        expect(rows).toHaveLength(2);

        // Overwrite (upsert) keeps one row per (contact, topic).
        await b.store.apiUnsubscribe.setContactTopicStatuses({
          tenantId: t, contactId, statuses: [{ topicId: news, status: "subscribed" }], source: "one_click", now: NOW,
        });
        const again = await b.store.apiContacts.listContactTopics({ tenantId: t, contactId });
        expect(again[0]).toMatchObject({ status: "subscribed", source: "one_click" });

        // A contact of another tenant is never written.
        const other = await b.newTenant();
        await b.store.apiUnsubscribe.setContactTopicStatuses({
          tenantId: other, contactId, statuses: [{ topicId: news, status: "unsubscribed" }], source: "page", now: NOW,
        });
        expect((await b.store.apiContacts.listContactTopics({ tenantId: t, contactId }))[0]!.status).toBe("subscribed");
      });

      it("applyContactTopics sets statuses by slug for the contact with that external id and reports unknown slugs", async () => {
        const t = await b.newTenant();
        const contactId = await seedContact(b, t, { externalId: "user-1" });
        await seedTopic(b, t, { slug: "news" });
        await seedTopic(b, t, { slug: "tips" });
        const result = await b.store.apiIngest.applyContactTopics({
          tenantId: t, externalId: "user-1", topics: { news: false, tips: true, nope: true }, source: "identify", now: NOW,
        });
        expect(result).toEqual({ applied: ["news", "tips"], unknown: ["nope"] });
        const statuses = await b.store.apiContacts.listContactTopics({ tenantId: t, contactId });
        expect(Object.fromEntries(statuses.map((s) => [s.slug, [s.status, s.source]]))).toEqual({
          news: ["unsubscribed", "identify"],
          tips: ["subscribed", "identify"],
        });
        await b.store.apiIngest.applyContactTopics({ tenantId: t, externalId: "user-1", topics: { news: true }, source: "identify", now: NOW });
        expect((await b.store.apiContacts.listContactTopics({ tenantId: t, contactId })).find((s) => s.slug === "news")!.status).toBe("subscribed");
        // Unknown contact: nothing written, slugs still classified.
        expect(
          await b.store.apiIngest.applyContactTopics({ tenantId: t, externalId: "nobody", topics: { news: true }, source: "identify", now: NOW }),
        ).toEqual({ applied: ["news"], unknown: [] });
        expect(await b.store.apiIngest.applyContactTopics({ tenantId: t, externalId: "user-1", topics: {}, source: "identify", now: NOW }))
          .toEqual({ applied: [], unknown: [] });
      });
    });

    // -----------------------------------------------------------------------
    // workerDrain
    // -----------------------------------------------------------------------

    describe("workerDrain", () => {
      it("getTopicGate returns the topic and the contact's status, tenant scoped", async () => {
        const t = await b.newTenant();
        const contactId = await seedContact(b, t);
        const topicId = await seedTopic(b, t, { kind: "lifecycle", defaultSubscribed: false });
        const q = b.store.workerDrain;
        expect(await q.getTopicGate({ tenantId: t, contactId, topicId })).toEqual({ kind: "lifecycle", defaultSubscribed: false, status: null });
        await b.store.apiUnsubscribe.setContactTopicStatuses({ tenantId: t, contactId, statuses: [{ topicId, status: "unsubscribed" }], source: "page", now: NOW });
        expect(await q.getTopicGate({ tenantId: t, contactId, topicId })).toEqual({ kind: "lifecycle", defaultSubscribed: false, status: "unsubscribed" });
        expect(await q.getTopicGate({ tenantId: await b.newTenant(), contactId, topicId })).toBeNull();
        expect(await q.getTopicGate({ tenantId: t, contactId: await seedContact(b, t), topicId })).toEqual({ kind: "lifecycle", defaultSubscribed: false, status: null });
      });

      it("claims carry the topic; markSent records the transport, markFailed / markSuppressed the reason", async () => {
        const t = await b.newTenant();
        const topicId = await seedTopic(b, t);
        const a = await seedMessage(b, { tenantId: t, status: "approved", topicId });
        const claimed = await b.store.workerDrain.claimDrainBatch({ now: NOW, limit: 10, tenantIds: [t] });
        expect(claimed.map((m) => [m.id, m.topicId])).toEqual([[a, topicId]]);

        const transportId = randomUUID();
        expect(await b.store.workerDrain.markSent(a, "pm-1", NOW, transportId)).toBe(true);
        expect(await getMessage(b, a)).toMatchObject({ status: "sent", transportId, providerMessageId: "pm-1", statusReason: null });

        const f = await seedMessage(b, { tenantId: t, status: "sending" });
        expect(await b.store.workerDrain.markFailed(f, NOW, "transport_policy")).toBe(true);
        expect(await getMessage(b, f)).toMatchObject({ status: "failed", statusReason: "transport_policy" });

        const s = await seedMessage(b, { tenantId: t, status: "sending" });
        expect(await b.store.workerDrain.markSuppressed(s, NOW, "topic_unsubscribed")).toBe(true);
        expect(await getMessage(b, s)).toMatchObject({ status: "suppressed", statusReason: "topic_unsubscribed" });

        // Without a reason / transport the columns stay null (as before).
        const plain = await seedMessage(b, { tenantId: t, status: "sending" });
        expect(await b.store.workerDrain.markSent(plain, null, NOW)).toBe(true);
        expect(await getMessage(b, plain)).toMatchObject({ status: "sent", transportId: null, statusReason: null });
      });

      it("countSentSince per transport counts that transport and unrecorded sends", async () => {
        const t = await b.newTenant();
        const x = randomUUID();
        const y = randomUUID();
        const since = new Date("2026-11-20T00:00:00Z");
        await seedMessage(b, { tenantId: t, status: "sent", sentAt: NOW, transportId: x });
        await seedMessage(b, { tenantId: t, status: "sent", sentAt: NOW, transportId: x });
        await seedMessage(b, { tenantId: t, status: "sent", sentAt: NOW, transportId: y });
        await seedMessage(b, { tenantId: t, status: "sent", sentAt: NOW });
        await seedMessage(b, { tenantId: t, status: "sent", sentAt: new Date("2026-11-19T00:00:00Z"), transportId: x });
        const q = b.store.workerDrain;
        expect(await q.countSentSince(t, since)).toBe(4);
        expect(await q.countSentSince(t, since, x)).toBe(3);
        expect(await q.countSentSince(t, since, y)).toBe(2);
      });
    });

    // -----------------------------------------------------------------------
    // Transports and routing
    // -----------------------------------------------------------------------

    describe("transports", () => {
      it("apiSettings: insert several active transports, list oldest first, find, update, deactivate", async () => {
        const t = await b.newTenant();
        const s = b.store.apiSettings;
        const first = await s.insertTransport({
          tenantId: t, kind: "resend", name: "Main", encryptedConfig: ENVELOPE, fromEmail: "a@x.io", fromName: "A", replyTo: "help@x.io", dailyLimit: 100,
        });
        expect(first).toEqual({
          id: expect.any(String),
          provider: "resend",
          kind: "resend",
          name: "Main",
          fromEmail: "a@x.io",
          fromName: "A",
          replyTo: "help@x.io",
          dailyLimit: 100,
          dkimVerified: false,
          isActive: true,
          createdAt: expect.any(Date),
        });
        // A later created_at so the order is deterministic on both backends.
        const second = await s.insertTransport({
          tenantId: t, kind: "cloudflare", name: null, encryptedConfig: ENVELOPE, fromEmail: "b@x.io", fromName: null, replyTo: null, dailyLimit: null,
        });
        await b.db.update(b.schema.transportConfigs).set({ createdAt: new Date(Date.now() + 1000) }).where(eq(b.schema.transportConfigs.id, second!.id));

        expect((await s.listActiveTransports(t)).map((r) => [r.id, r.kind])).toEqual([[first!.id, "resend"], [second!.id, "cloudflare"]]);
        const found = await s.findActiveTransport({ tenantId: t, id: second!.id });
        expect(found).toMatchObject({ id: second!.id, kind: "cloudflare", fromEmail: "b@x.io" });
        expect(JSON.parse(found!.config)).toEqual(JSON.parse(ENVELOPE));
        expect(await s.findActiveTransport({ tenantId: await b.newTenant(), id: second!.id })).toBeNull();

        const patched = await s.updateTransport({
          tenantId: t, id: first!.id, patch: { name: null, replyTo: null, dailyLimit: null, fromEmail: "c@x.io", encryptedConfig: JSON.stringify({ v: 2 }) },
        });
        expect(patched).toMatchObject({ id: first!.id, name: null, replyTo: null, dailyLimit: null, fromEmail: "c@x.io" });
        expect(JSON.parse((await s.findActiveTransport({ tenantId: t, id: first!.id }))!.config)).toEqual({ v: 2 });
        expect(await s.updateTransport({ tenantId: t, id: first!.id, patch: {} })).toMatchObject({ id: first!.id });

        expect(await s.deactivateTransport({ tenantId: await b.newTenant(), id: first!.id })).toBe(false);
        expect(await s.deactivateTransport({ tenantId: t, id: first!.id })).toBe(true);
        expect(await s.deactivateTransport({ tenantId: t, id: first!.id })).toBe(false);
        expect(await s.updateTransport({ tenantId: t, id: first!.id, patch: { name: "x" } })).toBeNull();
        expect((await s.listActiveTransports(t)).map((r) => r.id)).toEqual([second!.id]);
      });

      it("the v0.6 insert writes kind = provider; rows without kind read as their provider", async () => {
        const t = await b.newTenant();
        const legacy = await b.store.apiSettings.insertActiveTransportConfig({
          tenantId: t, provider: "smtp", encryptedConfig: ENVELOPE, fromEmail: "a@x.io", fromName: null, dailyLimit: null,
        });
        const [row] = await b.db.select().from(b.schema.transportConfigs).where(eq(b.schema.transportConfigs.id, legacy!.id));
        expect(row.kind).toBe("smtp");
        await b.db.update(b.schema.transportConfigs).set({ kind: null }).where(eq(b.schema.transportConfigs.id, legacy!.id));
        expect((await b.store.workerTransportResolver.listActiveTransports(t))[0]!.kind).toBe("smtp");
        expect((await b.store.apiSettings.listActiveTransports(t))[0]!.kind).toBe("smtp");
      });

      it("workerTransportResolver lists active transports oldest first and reads routing", async () => {
        const t = await b.newTenant();
        const r = b.store.workerTransportResolver;
        expect(await r.listActiveTransports(t)).toEqual([]);
        expect(await r.getTransportRouting(t)).toEqual({});
        expect(await r.getTransportRouting(randomUUID())).toEqual({});

        const older = randomUUID();
        const newer = randomUUID();
        const inactive = randomUUID();
        const base = { tenantId: t, provider: "resend", config: { v: 1 }, fromEmail: "a@x.io" };
        await b.db.insert(b.schema.transportConfigs).values([
          { ...base, id: newer, kind: "cloudflare", provider: "cloudflare", replyTo: "r@x.io", dailyLimit: 5, createdAt: new Date("2026-02-01T00:00:00Z") },
          { ...base, id: older, kind: "resend", fromName: "Old", createdAt: new Date("2026-01-01T00:00:00Z") },
          { ...base, id: inactive, kind: "smtp", isActive: false, createdAt: new Date("2025-01-01T00:00:00Z") },
        ]);
        const rows = await r.listActiveTransports(t);
        expect(rows.map((x) => ({ ...x, config: JSON.parse(x.config) }))).toEqual([
          { id: older, kind: "resend", provider: "resend", config: { v: 1 }, from_email: "a@x.io", from_name: "Old", reply_to: null, daily_limit: null },
          { id: newer, kind: "cloudflare", provider: "cloudflare", config: { v: 1 }, from_email: "a@x.io", from_name: null, reply_to: "r@x.io", daily_limit: 5 },
        ]);
        expect(await r.getActiveTransportConfig(t)).toMatchObject({ provider: "resend", from_name: "Old" });

        await b.store.apiSettings.updateTenantSettings(t, { postal_address: "x", transport_routing: { transactional: newer, default: older, junk: 1 } });
        expect(await r.getTransportRouting(t)).toEqual({ transactional: newer, default: older });
      });
    });

    // -----------------------------------------------------------------------
    // apiFlows
    // -----------------------------------------------------------------------

    describe("apiFlows", () => {
      it("creates and updates a flow's topic", async () => {
        const t = await b.newTenant();
        const topicId = await seedTopic(b, t);
        const created = await b.store.apiFlows.createFlow({
          tenantId: t, name: "F", description: null, priority: 0, triggerType: "manual", triggerConfig: {}, steps: [],
          source: "manual", contentMode: "ai_drafted", status: "draft", approvalMode: "require", flowClass: "nurture",
          reentryPolicy: "cooldown", reentryCooldownDays: 30, promptSource: null, compiledPlan: null, compiledAt: null, topicId,
        });
        expect(created!.topicId).toBe(topicId);
        const cleared = await b.store.apiFlows.updateFlow({ tenantId: t, id: created!.id, patch: { updatedAt: NOW, topicId: null } });
        expect(cleared!.topicId).toBeNull();
        const plain = await seedFlow(b, t);
        expect((await b.store.apiFlows.findFlow({ tenantId: t, id: plain }))!.topicId).toBeNull();
      });
    });
  });
}
