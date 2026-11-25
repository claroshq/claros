/**
 * Contract tests for the apiResendWebhook store area (every backend).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

/** Insert contact, flow and membership for a tenant; returns their ids. */
async function seedMembership(b: Backend, tenantId: string, contact: Record<string, unknown> = {}) {
  const contactId = randomUUID();
  const flowId = randomUUID();
  const membershipId = randomUUID();
  await b.db.insert(b.schema.contacts).values({
    id: contactId,
    tenantId,
    externalId: `ext-${contactId.slice(0, 8)}`,
    lifecycleState: "signed_up",
    ...contact,
  });
  await b.db.insert(b.schema.flows).values({
    id: flowId,
    tenantId,
    name: "Flow",
    triggerType: "event",
    triggerConfig: {},
    steps: [],
  });
  await b.db.insert(b.schema.flowMemberships).values({
    id: membershipId,
    tenantId,
    contactId,
    flowId,
    enteredAt: new Date(),
  });
  return { contactId, flowId, membershipId };
}

let stepCounter = 0;

/** Insert a lifecycle message (new membership unless given); returns its id. */
async function seedMessage(
  b: Backend,
  tenantId: string,
  values: Record<string, unknown> = {},
  membership?: { contactId: string; flowId: string; membershipId: string },
) {
  const m = membership ?? (await seedMembership(b, tenantId));
  const id = (values.id as string | undefined) ?? randomUUID();
  await b.db.insert(b.schema.lifecycleMessages).values({
    id,
    tenantId,
    contactId: m.contactId,
    flowId: m.flowId,
    membershipId: m.membershipId,
    flowStepOrder: ++stepCounter,
    status: "pending_approval",
    ...values,
  });
  return id;
}

for (const factory of testBackends()) {
  describe(`apiResendWebhook on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const feedbackOf = async (id: string) => {
      const [row] = await b.db
        .select({ feedback: b.schema.lifecycleMessages.feedback, updatedAt: b.schema.lifecycleMessages.updatedAt })
        .from(b.schema.lifecycleMessages)
        .where(eq(b.schema.lifecycleMessages.id, id));
      return row as { feedback: string | null; updatedAt: Date };
    };

    it("findActiveResendConfig returns the active resend config text", async () => {
      const t = await b.newTenant();
      const envelope = { v: 1, alg: "aes-256-gcm", iv: "00", tag: "11", data: "22" };
      expect(await b.store.apiResendWebhook.findActiveResendConfig(t)).toBeNull();
      const tc = b.schema.transportConfigs;
      await b.db.insert(tc).values({ tenantId: t, provider: "resend", config: { old: true }, isActive: false, fromEmail: "a@x.io" });
      await b.db.insert(tc).values({ tenantId: t, provider: "smtp", config: { smtp: true }, isActive: true, fromEmail: "a@x.io" });
      expect(await b.store.apiResendWebhook.findActiveResendConfig(t)).toBeNull();
      await b.db.insert(tc).values({ tenantId: t, provider: "resend", config: envelope, isActive: true, fromEmail: "a@x.io" });
      const text = await b.store.apiResendWebhook.findActiveResendConfig(t);
      expect(typeof text).toBe("string");
      expect(JSON.parse(text!)).toEqual(envelope);
      // uppercase uuid input resolves like Postgres' uuid cast
      expect(JSON.parse((await b.store.apiResendWebhook.findActiveResendConfig(t.toUpperCase()))!)).toEqual(envelope);
    });

    it("findActiveResendConfig throws on a malformed tenant id", async () => {
      await expect(b.store.apiResendWebhook.findActiveResendConfig("not-a-uuid")).rejects.toThrow();
    });

    it.runIf(factory.name === "d1")("d1: findActiveResendConfig unwraps a config stored as a JSON string literal", async () => {
      const t = await b.newTenant();
      const envelopeText = JSON.stringify({ v: 1, iv: "00" });
      // Drizzle json mode given a string stores it double-encoded
      await b.db.insert(b.schema.transportConfigs).values({ tenantId: t, provider: "resend", config: envelopeText, fromEmail: "a@x.io" });
      expect(await b.store.apiResendWebhook.findActiveResendConfig(t)).toBe(envelopeText);
    });

    it("setTerminalFeedback overrides non-terminal feedback but never another terminal", async () => {
      const t = await b.newTenant();
      const opened = await seedMessage(b, t, { status: "sent", feedback: "opened", updatedAt: new Date(0) });
      expect(await b.store.apiResendWebhook.setTerminalFeedback({ messageId: opened, feedback: "bounced" })).toBe(true);
      const after = await feedbackOf(opened);
      expect(after.feedback).toBe("bounced");
      expect(after.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(await b.store.apiResendWebhook.setTerminalFeedback({ messageId: opened, feedback: "complained" })).toBe(false);
      const fresh = await seedMessage(b, t, { status: "sent" });
      expect(await b.store.apiResendWebhook.setTerminalFeedback({ messageId: fresh, feedback: "complained" })).toBe(true);
      expect((await feedbackOf(fresh)).feedback).toBe("complained");
    });

    it("setTerminalFeedback: concurrent terminal events, exactly one applies", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, t, { status: "sent", feedback: "clicked" });
      const results = await Promise.all([
        b.store.apiResendWebhook.setTerminalFeedback({ messageId: id, feedback: "bounced" }),
        b.store.apiResendWebhook.setTerminalFeedback({ messageId: id, feedback: "complained" }),
        b.store.apiResendWebhook.setTerminalFeedback({ messageId: id, feedback: "bounced" }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(["bounced", "complained"]).toContain((await feedbackOf(id)).feedback);
    });

    it("advanceFeedback applies only from a listed predecessor (null = none yet)", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, t, { status: "sent" });
      expect(await b.store.apiResendWebhook.advanceFeedback({ messageId: id, feedback: "clicked", predecessors: ["opened"] })).toBe(false);
      expect(await b.store.apiResendWebhook.advanceFeedback({ messageId: id, feedback: "opened", predecessors: [null] })).toBe(true);
      expect((await feedbackOf(id)).feedback).toBe("opened");
      expect(await b.store.apiResendWebhook.advanceFeedback({ messageId: id, feedback: "opened", predecessors: [null] })).toBe(false);
      expect(await b.store.apiResendWebhook.advanceFeedback({ messageId: id, feedback: "clicked", predecessors: [null, "opened"] })).toBe(true);
      expect((await feedbackOf(id)).feedback).toBe("clicked");
      // never regresses
      expect(await b.store.apiResendWebhook.advanceFeedback({ messageId: id, feedback: "opened", predecessors: [null] })).toBe(false);
      const bounced = await seedMessage(b, t, { status: "sent", feedback: "bounced" });
      expect(await b.store.apiResendWebhook.advanceFeedback({ messageId: bounced, feedback: "clicked", predecessors: [null, "opened"] })).toBe(false);
      expect((await feedbackOf(bounced)).feedback).toBe("bounced");
    });

    it("advanceFeedback: concurrent advances from the same state, exactly one applies", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, t, { status: "sent" });
      const results = await Promise.all([
        b.store.apiResendWebhook.advanceFeedback({ messageId: id, feedback: "opened", predecessors: [null] }),
        b.store.apiResendWebhook.advanceFeedback({ messageId: id, feedback: "opened", predecessors: [null] }),
        b.store.apiResendWebhook.advanceFeedback({ messageId: id, feedback: "opened", predecessors: [null] }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("insertSuppression is a no-op when the address exists (case-insensitive), also concurrently", async () => {
      const t = await b.newTenant();
      await Promise.all([
        b.store.apiResendWebhook.insertSuppression({ tenantId: t, email: "bob@example.com", reason: "hard_bounce" }),
        b.store.apiResendWebhook.insertSuppression({ tenantId: t, email: "bob@example.com", reason: "complaint" }),
      ]);
      await b.db
        .insert(b.schema.suppressions)
        .values({ tenantId: t, email: "Carl@Example.com", reason: "manual", source: "admin" });
      await b.store.apiResendWebhook.insertSuppression({ tenantId: t, email: "carl@example.com", reason: "complaint" });
      const rows = await b.db.select().from(b.schema.suppressions).where(eq(b.schema.suppressions.tenantId, t));
      expect(rows).toHaveLength(2);
      const bob = rows.find((r: any) => r.email === "bob@example.com");
      expect(bob.source).toBe("webhook");
      expect(["hard_bounce", "complaint"]).toContain(bob.reason);
      expect(rows.find((r: any) => r.email === "Carl@Example.com").reason).toBe("manual");
    });

    it("findMessageByProviderId is tenant scoped", async () => {
      const t = await b.newTenant();
      const pid = `re_${randomUUID()}`;
      const id = await seedMessage(b, t, { status: "sent", providerMessageId: pid, recipientAddress: "d@example.com" });
      expect(await b.store.apiResendWebhook.findMessageByProviderId({ tenantId: t, providerMessageId: pid })).toEqual({
        id,
        tenantId: t,
        recipientAddress: "d@example.com",
      });
      expect(await b.store.apiResendWebhook.findMessageByProviderId({ tenantId: await b.newTenant(), providerMessageId: pid })).toBeNull();
      expect(await b.store.apiResendWebhook.findMessageByProviderId({ tenantId: t, providerMessageId: "nope" })).toBeNull();
    });

    it("insertMessageEvent stores events, deduplicates by provider event id; countMessageEvents counts", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, t, { status: "sent" });
      expect(await b.store.apiResendWebhook.countMessageEvents(id)).toBe(0);
      const occurredAt = "2026-03-04T05:06:07.089Z";
      const ev = (providerEventId: string | null, metadataJson: string | null = null) =>
        b.store.apiResendWebhook.insertMessageEvent({ tenantId: t, messageId: id, eventType: "clicked", occurredAt, providerEventId, metadataJson });
      await Promise.all([ev("evt_1", JSON.stringify({ link: "https://x.io", n: null })), ev("evt_1")]);
      await ev("evt_1");
      await ev(null);
      await ev(null);
      await ev("evt_meta", JSON.stringify({ link: "https://y.io", n: null }));
      expect(await b.store.apiResendWebhook.countMessageEvents(id)).toBe(4);

      const rows = await b.db
        .select()
        .from(b.schema.messageEvents)
        .where(eq(b.schema.messageEvents.messageId, id))
        .orderBy(sql`${b.schema.messageEvents.providerEventId} IS NULL`);
      expect(rows[0]).toMatchObject({ tenantId: t, eventType: "clicked", providerEventId: "evt_1" });
      expect(rows[0].occurredAt.getTime()).toBe(Date.parse(occurredAt));
      expect(rows[0].createdAt).toBeInstanceOf(Date);
      const meta = rows.find((r: any) => r.providerEventId === "evt_meta");
      expect(meta.metadata).toEqual({ link: "https://y.io", n: null });
      expect(rows[3].metadata).toBeNull();

      // dedup is per tenant
      const other = await b.newTenant();
      const otherMsg = await seedMessage(b, other, { status: "sent" });
      await b.store.apiResendWebhook.insertMessageEvent({
        tenantId: other, messageId: otherMsg, eventType: "opened", occurredAt, providerEventId: "evt_1", metadataJson: null,
      });
      expect(await b.store.apiResendWebhook.countMessageEvents(otherMsg)).toBe(1);
    });
  });
}
