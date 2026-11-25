/**
 * P5b engine behaviour on Postgres (when DATABASE_URL is set) and D1, with a
 * fake LLM and fake transports: trigger `where` and event lists, lifecycle
 * segments, {{event.*}} and trait sections, condition combinators, the LLM
 * budget, the value-gate settings, allowed_links and single_cta, step
 * persona fields at send time, archived products and the daily approvals mail.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { storeFor } from "@claros/store";
import { handleTriggerCheck } from "../src/trigger-check.js";
import { phaseEnrollment } from "../src/scan-enrollment.js";
import { phaseSegmentEnrollment } from "../src/scan-segment-enrollment.js";
import { handleAdvanceMembership } from "../src/advance-membership.js";
import { processContentTick } from "../src/content.js";
import { processDrainTick, fetchDrainBatchSimple, type FetchDrainBatch } from "../src/drain.js";
import { evaluateStepCondition } from "../src/condition-evaluator.js";
import { runApprovalsDigest } from "../src/approvals-digest.js";
import { utcDay } from "../src/provider-resolver.js";
import { engineBackends, type EngineBackend } from "./support/engine-backends.js";
import { startFakeLlm, useFakeLlm, DEFAULT_ANSWERS, type FakeLlm } from "./support/fake-llm.js";
import { fakeTransports } from "./support/fake-transport.js";

const SIGNING_KEY = "a".repeat(64);

describe("step condition combinators (evaluator)", () => {
  const checker = { hasEventSince: async (e: string) => e === "seen", contact: { now: new Date(), traits: async () => ({ plan: "free" }), countSends: async () => 0 } };
  it("decides all / any / not and lists", async () => {
    const free = { trait: { key: "plan", op: "eq", value: "free" } };
    const at = new Date();
    expect((await evaluateStepCondition({ all: [free, { event_since_step: "seen" }] }, { lifecycleState: "engaged" }, checker, at)).outcome).toBe("pass");
    expect((await evaluateStepCondition({ not: { lifecycle_state: "engaged" } }, { lifecycleState: "engaged" }, checker, at)).outcome).toBe("fail");
    expect((await evaluateStepCondition([free, { any: [{ lifecycle_state: "x" }, { first_contact: true }] }], { lifecycleState: "engaged" }, checker, at)).outcome).toBe("pass");
    expect((await evaluateStepCondition({ all: [{ bogus: 1 }] }, { lifecycleState: "engaged" }, checker, at)).outcome).toBe("unknown_shape");
  });
});

for (const factory of engineBackends()) {
  describe(`P5b engine (${factory.name})`, () => {
    let b: EngineBackend;
    let llm: FakeLlm;
    beforeAll(async () => {
      b = await factory.open();
      llm = await startFakeLlm();
    });
    afterAll(async () => {
      await llm.close();
      await b.close();
    });

    async function flow(tenantId: string, values: Record<string, unknown>) {
      const id = randomUUID();
      const steps = (values.steps as unknown[]) ?? [{ order: 1, action_type: "a", delay: "0m", template_ref: "t" }];
      const type = (values.triggerType as string) ?? "event";
      const cfg = (values.triggerConfig as Record<string, unknown>) ?? { event: "x" };
      await b.db.insert(b.schema.flows).values({
        id, tenantId, name: "F", triggerType: type, triggerConfig: cfg, steps, status: "active", compileStatus: "ready",
        compiledPlan: { trigger: { type, condition: cfg }, steps, ...(values.exits ? { exit_conditions: values.exits } : {}) },
        flowClass: (values.flowClass as string) ?? "critical", approvalMode: (values.approvalMode as string) ?? "auto",
        ...(values.topicId ? { topicId: values.topicId } : {}),
      });
      return id;
    }
    async function contact(tenantId: string, props: Record<string, unknown> = {}, state = "engaged", extra: Record<string, unknown> = {}) {
      const id = randomUUID();
      const externalId = `u-${id.slice(0, 8)}`;
      await b.db.insert(b.schema.contacts).values({ id, tenantId, externalId, email: `${externalId}@example.com`, lifecycleState: state, properties: props, ...extra });
      return id;
    }
    const memberships = (tenantId: string, flowId: string) =>
      b.db.select().from(b.schema.flowMemberships).where(and(eq(b.schema.flowMemberships.tenantId, tenantId), eq(b.schema.flowMemberships.flowId, flowId)));
    const messages = (tenantId: string) => b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.tenantId, tenantId));
    const message = async (id: string) => (await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, id)))[0];

    it("event lists, combinator where with lifecycle leaves, and {{event.*}} / trait sections in templates", async () => {
      const t = await b.newTenant({ postal_address: "1 Test St" });
      await b.db.insert(b.schema.templates).values({
        tenantId: t, slug: "plan", name: "Plan", subject: "Now on {{event.new_plan}}",
        bodyHtml: "<p>You moved to {{event.new_plan}}.{{#traits.founding}} Your founding price stays.{{/traits.founding}}</p>", isActive: true,
      });
      const f = await flow(t, {
        triggerConfig: { event: ["upgraded", "downgraded"], where: { all: [{ not: { lifecycle_state: "churned" } }, { any: [{ trait: { key: "paid", op: "eq", value: true } }, { first_contact: true }] }] } },
        steps: [{ order: 1, action_type: "plan_changed", delay: "0m", template_ref: "plan" }],
      });
      const yes = await contact(t, { paid: true, founding: true });
      const churned = await contact(t, { paid: true }, "churned");
      const r1 = await handleTriggerCheck({ tenant_id: t, contact_id: yes, event_name: "downgraded", event_properties: { new_plan: "Pro" } }, b.db);
      const r2 = await handleTriggerCheck({ tenant_id: t, contact_id: churned, event_name: "upgraded" }, b.db);
      const r3 = await handleTriggerCheck({ tenant_id: t, contact_id: yes, event_name: "other" }, b.db);
      expect(r1.enrolledMembershipIds).toHaveLength(1);
      expect(r2.enrolledMembershipIds).toHaveLength(0);
      expect(r3.enrolledMembershipIds).toHaveLength(0);
      await handleAdvanceMembership({ tenant_id: t, membership_id: r1.enrolledMembershipIds[0]! }, b.db);
      await processContentTick(b.db, new Date(), 20, [t]);
      const [m] = await messages(t);
      expect(m.status).toBe("approved");
      expect(m.subject).toBe("Now on Pro");
      expect(m.bodyHtml).toContain("You moved to Pro. Your founding price stays.");
      expect((await memberships(t, f))[0].triggerProperties).toEqual({ new_plan: "Pro" });
    });

    it("lifecycle_transition where and a missing from", async () => {
      const t = await b.newTenant();
      const f = await flow(t, { triggerType: "lifecycle_transition", triggerConfig: { to: "churned", where: { not: { all: [{ trait: { key: "plan", op: "eq", value: "free" } }, { first_contact: true }] } } } });
      const freeNew = await contact(t, { plan: "free" }, "churned");
      const paid = await contact(t, { plan: "pro" }, "churned");
      await phaseEnrollment(b.db, [
        { tenantId: t, contactId: freeNew, fromState: "dormant", toState: "churned" },
        { tenantId: t, contactId: paid, fromState: "dormant", toState: "churned" },
      ], new Date());
      expect((await memberships(t, f)).map((m: any) => m.contactId)).toEqual([paid]);
    });

    it("segment by lifecycle state and engagement depth, with where", async () => {
      const t = await b.newTenant();
      const f = await flow(t, { triggerType: "segment", triggerConfig: { lifecycle_states: ["engaged", "at_risk"], engagement_depths: ["power", "regular"], where: [{ trait: { key: "optin", op: "neq", value: false } }] }, flowClass: "nurture" });
      const a = await contact(t, {}, "engaged", { engagementDepth: "power" });
      await contact(t, {}, "dormant", { engagementDepth: "power" });
      await contact(t, {}, "at_risk", { engagementDepth: "casual" });
      await contact(t, { optin: false }, "at_risk", { engagementDepth: "regular" });
      const r = await phaseSegmentEnrollment(b.db, new Date(), [t]);
      expect(r.flowsEvaluated).toBe(1);
      expect((await memberships(t, f)).map((m: any) => m.contactId)).toEqual([a]);
    });

    async function aiMessage(settings: Record<string, unknown>, stepExtra: Record<string, unknown> = {}) {
      const t = await b.newTenant(settings);
      await useFakeLlm(b, t, llm);
      const steps = [{ order: 1, action_type: "nurture_value", delay: "0m", brain_instruction: "Write something.", ...stepExtra }];
      const f = await flow(t, { steps, approvalMode: "require" });
      const c = await contact(t);
      const membershipId = randomUUID();
      await b.db.insert(b.schema.flowMemberships).values({ id: membershipId, tenantId: t, contactId: c, flowId: f, enteredAt: new Date(), status: "active" });
      const id = randomUUID();
      await b.db.insert(b.schema.lifecycleMessages).values({ id, tenantId: t, contactId: c, flowId: f, membershipId, flowStepOrder: 1, status: "pending_generation", brainActionType: "nurture_value" });
      return { t, id };
    }

    it("LLM daily budget: tokens are counted; over budget the draft waits (llm_budget) without an LLM call", async () => {
      llm.answer = (c) => DEFAULT_ANSWERS[c.kind];
      const { t, id } = await aiMessage({ llm_daily_token_budget: 1000 });
      await processContentTick(b.db, new Date(), 20, [t]);
      expect((await message(id)).status).toBe("pending_approval");
      // The fake reports 2 tokens per call.
      expect(await storeFor(b.db).workerProviderResolver.getLlmTokens({ tenantId: t, day: utcDay(new Date()) })).toBeGreaterThan(0);

      const second = await aiMessage({ llm_daily_token_budget: 1000 });
      await storeFor(b.db).workerProviderResolver.addLlmTokens({ tenantId: second.t, day: utcDay(new Date()), tokens: 1000 });
      llm.calls.length = 0;
      const tick = await processContentTick(b.db, new Date(), 20, [second.t]);
      expect(tick.deferred).toBe(1);
      const m = await message(second.id);
      expect(m.status).toBe("pending_generation");
      expect(m.statusReason).toBe("llm_budget");
      expect(llm.calls).toHaveLength(0);
    });

    it("brain.assess: disabled skips the gate; a threshold gates low scores", async () => {
      llm.calls.length = 0;
      const off = await aiMessage({ brain: { assess: { enabled: false } } });
      await processContentTick(b.db, new Date(), 20, [off.t]);
      expect((await message(off.id)).status).toBe("pending_approval");
      expect(llm.calls.some((c) => c.kind === "assess")).toBe(false);

      llm.answer = (c) => (c.kind === "assess" ? { verdict: "pass", score: 4, reasoning: "meh" } : DEFAULT_ANSWERS[c.kind]);
      const strict = await aiMessage({ brain: { assess: { threshold: 6 } } });
      llm.calls.length = 0;
      await processContentTick(b.db, new Date(), 20, [strict.t]);
      const m = await message(strict.id);
      expect(m.status).toBe("value_gated");
      expect(m.brainReasoning).toContain("below the threshold 6");
      expect(llm.calls.find((c) => c.kind === "assess")!.system).toContain('"score"');
      llm.answer = (c) => DEFAULT_ANSWERS[c.kind];
    });

    it("allowed_links narrows the allowlist; single_cta blocks a second link", async () => {
      const settings = { links: { home: "https://p.example/home", billing: "https://p.example/billing" }, link_tracking: { domains: ["p.example"] } };
      llm.answer = (c) => (c.kind === "draft" ? { subject: "Hi", body_markdown: "See [billing](https://p.example/billing)." } : DEFAULT_ANSWERS[c.kind]);
      const narrowed = await aiMessage(settings, { allowed_links: ["home"] });
      await processContentTick(b.db, new Date(), 20, [narrowed.t]);
      expect((await message(narrowed.id)).statusReason).toBe("link_not_allowed");
      expect(llm.calls.filter((c) => c.kind === "draft").at(-1)!.user).not.toContain("https://p.example/billing");

      llm.answer = (c) => (c.kind === "draft" ? { subject: "Hi", body_markdown: "[Home](https://p.example/home) or [billing](https://p.example/billing)." } : DEFAULT_ANSWERS[c.kind]);
      const single = await aiMessage(settings, { single_cta: true });
      await processContentTick(b.db, new Date(), 20, [single.t]);
      const m = await message(single.id);
      expect(m.status).toBe("failed");
      expect(m.statusReason).toBe("single_cta");
      llm.answer = (c) => DEFAULT_ANSWERS[c.kind];
    });

    it("send time: from_name, reply_to, eyebrow and preheader; archived products are not drained", async () => {
      const t = await b.newTenant({ postal_address: "1 Test St" });
      const steps = [{ order: 1, action_type: "a", delay: "0m", template_ref: "t", from_name: "Umut from Product", reply_to: "umut@product.example", eyebrow: "QUICK TIP", preheader: "One minute read" }];
      const f = await flow(t, { steps });
      const c = await contact(t);
      const membershipId = randomUUID();
      await b.db.insert(b.schema.flowMemberships).values({ id: membershipId, tenantId: t, contactId: c, flowId: f, enteredAt: new Date(), status: "active" });
      const id = randomUUID();
      await b.db.insert(b.schema.lifecycleMessages).values({ id, tenantId: t, contactId: c, flowId: f, membershipId, flowStepOrder: 1, status: "approved", subject: "S", bodyHtml: "<p>Body</p>", bodyText: "Body" });
      const fake = fakeTransports();
      const scoped: FetchDrainBatch = (d, n, limit, ids) => fetchDrainBatchSimple(d, n, limit, ids.filter((x) => x === t));
      const archived = await b.newTenant({ postal_address: "1 Test St" });
      await b.db.update(b.schema.tenants).set({ archivedAt: new Date() }).where(eq(b.schema.tenants.id, archived));
      const r = await processDrainTick(b.db, new Date(), fake.resolver([t, archived]), scoped, 50, "http://localhost:3000", SIGNING_KEY, false);
      expect(r.sent).toBe(1);
      const mail = fake.sent[0]!;
      expect(mail.fromName).toBe("Umut from Product");
      expect(mail.from).toBe("hello@product.example");
      expect(mail.replyTo).toBe("umut@product.example");
      expect(mail.bodyHtml).toContain("QUICK TIP");
      expect(mail.bodyHtml).toContain("One minute read");
      expect(mail.bodyHtml.indexOf("One minute read")).toBeLessThan(mail.bodyHtml.indexOf("QUICK TIP"));
    });

    it("approvals digest: once per local day from 08:00, to owners, through the transactional route", async () => {
      const t = await b.newTenant({ approvals: { daily_digest: true }, throttle: { tenant_timezone: "Europe/Madrid" } });
      const owner = randomUUID();
      await b.db.insert(b.schema.users).values({ id: owner, tenantId: t, email: `owner-${owner.slice(0, 6)}@example.com`, role: "owner" });
      await b.db.insert(b.schema.memberships).values({ userId: owner, tenantId: t, role: "owner" });
      const f = await flow(t, {});
      const c = await contact(t);
      const membershipId = randomUUID();
      await b.db.insert(b.schema.flowMemberships).values({ id: membershipId, tenantId: t, contactId: c, flowId: f, enteredAt: new Date(), status: "active" });
      await b.db.insert(b.schema.lifecycleMessages).values({ tenantId: t, contactId: c, flowId: f, membershipId, flowStepOrder: 1, status: "pending_approval" });
      const fake = fakeTransports();
      // 06:30 UTC is 07:30 in Madrid (winter): not yet.
      expect((await runApprovalsDigest(b.db, new Date("2026-12-01T06:30:00Z"), { resolveTransport: fake.resolver([t]) })).sent).toEqual([]);
      expect((await runApprovalsDigest(b.db, new Date("2026-12-01T07:05:00Z"), { resolveTransport: fake.resolver([t]) })).sent).toEqual([t]);
      expect((await runApprovalsDigest(b.db, new Date("2026-12-01T15:00:00Z"), { resolveTransport: fake.resolver([t]) })).sent).toEqual([]);
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]!.transport).toBe("cloudflare");
      expect(fake.sent[0]!.subject).toBe("1 draft waits for approval in Test");
      expect(fake.sent[0]!.headers).toEqual({});
      expect((await runApprovalsDigest(b.db, new Date("2026-12-02T07:05:00Z"), { resolveTransport: fake.resolver([t]) })).sent).toEqual([t]);
    });
  });
}
