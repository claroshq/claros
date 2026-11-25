/**
 * G27 choose step on Postgres (when DATABASE_URL is set) and D1 with a fake
 * OpenAI-compatible LLM: deterministic filters first, the LLM sees eligible
 * candidates only, out-of-set answers are retried once then recorded as
 * none, forced actions carry the filter result as a warning.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { processContentTick } from "../src/content.js";
import { engineBackends, type EngineBackend } from "./support/engine-backends.js";
import { startFakeLlm, useFakeLlm, DEFAULT_ANSWERS, type FakeLlm } from "./support/fake-llm.js";

const DAY = 86_400_000;

for (const factory of engineBackends()) {
  describe(`choose step (${factory.name})`, () => {
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

    const step = {
      order: 1,
      action_type: "nurture",
      delay: "0m",
      type: "choose",
      allow_none: true,
      brain_instruction: "One short, useful note.",
      candidates: [
        { action_type: "tip_trick", cooldown: "14d", brain_instruction: "Share a tip." },
        { action_type: "onboarding_rescue", when: [{ trait: { key: "stage", op: "eq", value: "at_risk" } }], brain_instruction: "Help them get going." },
        { action_type: "feature_edu", kb_select: { category: "feature_edu" } },
      ],
    };

    async function setup(traits: Record<string, unknown>, opts: { forced?: string } = {}) {
      const tenantId = await b.newTenant({ throttle: { max_emails_per_user_per_day: 5, max_emails_per_user_per_week: 10 } });
      await useFakeLlm(b, tenantId, llm);
      const flowId = randomUUID();
      const steps = [step];
      await b.db.insert(b.schema.flows).values({
        id: flowId, tenantId, slug: "nurture", name: "Nurture", triggerType: "event", triggerConfig: { event: "x" }, steps, status: "active",
        compileStatus: "ready", compiledPlan: { trigger: { type: "event", condition: { event: "x" } }, steps }, approvalMode: "require",
      });
      const contactId = randomUUID();
      await b.db.insert(b.schema.contacts).values({ id: contactId, tenantId, externalId: "u", email: "u@example.com", lifecycleState: "engaged", properties: traits });
      // A tip went out 3 days ago (cooldown 14d).
      const old = randomUUID();
      await b.db.insert(b.schema.flowMemberships).values({ id: old, tenantId, contactId, flowId, enteredAt: new Date(Date.now() - 3 * DAY), status: "completed" });
      await b.db.insert(b.schema.lifecycleMessages).values({ tenantId, contactId, flowId, membershipId: old, flowStepOrder: 1, status: "sent", brainActionType: "tip_trick", sentAt: new Date(Date.now() - 3 * DAY) });
      const membershipId = randomUUID();
      await b.db.insert(b.schema.flowMemberships).values({ id: membershipId, tenantId, contactId, flowId, enteredAt: new Date(), status: "active" });
      const id = randomUUID();
      await b.db.insert(b.schema.lifecycleMessages).values({
        id, tenantId, contactId, flowId, membershipId, flowStepOrder: 1, status: "pending_generation", brainActionType: "nurture",
        ...(opts.forced ? { forcedActionType: opts.forced } : {}),
      });
      return { tenantId, id };
    }
    const message = async (id: string) => (await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, id)))[0];

    it("never picks a candidate filtered out by cooldown: an out-of-set answer is retried once, then none", async () => {
      llm.calls.length = 0;
      llm.answer = (c) => (c.kind === "choose" ? { choice: "tip_trick", reason: "they like tips" } : DEFAULT_ANSWERS[c.kind]);
      const { tenantId, id } = await setup({ stage: "at_risk" });
      await processContentTick(b.db, new Date(), 20, [tenantId]);
      const m = await message(id);
      expect(m.status).toBe("skipped");
      const chooseCalls = llm.calls.filter((c) => c.kind === "choose");
      expect(chooseCalls).toHaveLength(2);
      expect(chooseCalls[0]!.user).toContain("- onboarding_rescue");
      expect(chooseCalls[0]!.user).not.toContain("- tip_trick");
      expect(llm.calls.some((c) => c.kind === "draft")).toBe(false);
      expect(m.chooseDecision).toMatchObject({
        choice: "none",
        eligible: ["onboarding_rescue"],
        rejected_answers: ["tip_trick", "tip_trick"],
      });
      expect(m.chooseDecision.filtered_out).toEqual(
        expect.arrayContaining([
          { action_type: "tip_trick", reason: "cooldown" },
          { action_type: "feature_edu", reason: "kb_exhausted" },
        ]),
      );
    });

    it("drafts the picked candidate and records the decision", async () => {
      llm.calls.length = 0;
      llm.answer = (c) => (c.kind === "choose" ? { choice: "onboarding_rescue", reason: "at risk" } : DEFAULT_ANSWERS[c.kind]);
      const { tenantId, id } = await setup({ stage: "at_risk" });
      await processContentTick(b.db, new Date(), 20, [tenantId]);
      const m = await message(id);
      expect(m.status).toBe("pending_approval");
      expect(m.brainActionType).toBe("onboarding_rescue");
      expect(m.chooseDecision).toMatchObject({ choice: "onboarding_rescue", reason: "at risk", eligible: ["onboarding_rescue"] });
      expect(llm.calls.some((c) => c.kind === "decide")).toBe(false);
      expect(llm.calls.find((c) => c.kind === "draft")!.user).toContain("Help them get going.");
    });

    it("records none without an LLM call when nothing is eligible", async () => {
      llm.calls.length = 0;
      const { tenantId, id } = await setup({ stage: "fine" });
      await processContentTick(b.db, new Date(), 20, [tenantId]);
      const m = await message(id);
      expect(m.status).toBe("skipped");
      expect(m.chooseDecision).toMatchObject({ choice: "none", eligible: [], reason: "no eligible candidate" });
      expect(llm.calls).toHaveLength(0);
    });

    it("a forced action may pick a filtered candidate, with the filter result as a warning", async () => {
      llm.calls.length = 0;
      const { tenantId, id } = await setup({ stage: "fine" }, { forced: "tip_trick" });
      await processContentTick(b.db, new Date(), 20, [tenantId]);
      const m = await message(id);
      expect(m.status).toBe("pending_approval");
      expect(m.brainActionType).toBe("tip_trick");
      expect(m.chooseDecision).toMatchObject({ choice: "tip_trick", forced: true, warning: "filtered out: cooldown" });
      expect(llm.calls.some((c) => c.kind === "choose")).toBe(false);
    });
  });
}
