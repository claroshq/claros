/**
 * G19 named links, link allowlist and text rules, G22 guidelines and locale,
 * G18 pinned KB, in the AI content pipeline on Postgres (when DATABASE_URL is
 * set) and D1, with a fake OpenAI-compatible LLM.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { processContentTick } from "../src/content.js";
import { applyTextRules, findDisallowedLinks } from "../src/draft-checks.js";
import { engineBackends, type EngineBackend } from "./support/engine-backends.js";
import { startFakeLlm, useFakeLlm, DEFAULT_ANSWERS, type FakeLlm } from "./support/fake-llm.js";

describe("draft checks", () => {
  it("applies find/replace and forbid rules", () => {
    const r = applyTextRules([{ find: "Fundup ", replace: "Fundup AI " }, { find: "/—/g", replace: "," }, { forbid: "free trial" }], {
      subject: "Fundup news",
      body: "Try Fundup — now with a Free Trial",
    });
    expect(r.subject).toBe("Fundup AI news");
    expect(r.body).toBe("Try Fundup AI , now with a Free Trial");
    expect(r.forbidden).toEqual(["free trial"]);
  });
  it("allows named links, tracked domains and context URLs only", () => {
    const allow = { links: { icp_url: "https://fundup.ai/icp" }, trackedDomains: ["fundup.ai"], context: { leads: [{ url: "https://acme.example/" }] } };
    expect(findDisallowedLinks("see https://fundup.ai/icp?x=1 and [docs](https://docs.fundup.ai/a). https://acme.example/", allow)).toEqual([]);
    expect(findDisallowedLinks("go to https://evil.example/x.", allow)).toEqual(["https://evil.example/x"]);
  });
});

for (const factory of engineBackends()) {
  describe(`brain product settings (${factory.name})`, () => {
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

    async function setup(settings: Record<string, unknown>, locale: string | null = null) {
      const tenantId = await b.newTenant(settings);
      if (locale) await b.db.update(b.schema.tenants).set({ locale }).where(eq(b.schema.tenants.id, tenantId));
      await useFakeLlm(b, tenantId, llm);
      const flowId = randomUUID();
      const steps = [{ order: 1, action_type: "nurture_value", delay: "0m", brain_instruction: "Point them at {{links.icp_url}}." }];
      await b.db.insert(b.schema.flows).values({
        id: flowId, tenantId, name: "AI", triggerType: "event", triggerConfig: { event: "x" }, steps, status: "active",
        compileStatus: "ready", compiledPlan: { trigger: { type: "event", condition: { event: "x" } }, steps }, approvalMode: "require",
      });
      const contactId = randomUUID();
      await b.db.insert(b.schema.contacts).values({ id: contactId, tenantId, externalId: "u", email: "u@example.com", lifecycleState: "engaged", properties: {} });
      const membershipId = randomUUID();
      await b.db.insert(b.schema.flowMemberships).values({ id: membershipId, tenantId, contactId, flowId, enteredAt: new Date(), status: "active" });
      const id = randomUUID();
      await b.db.insert(b.schema.lifecycleMessages).values({ id, tenantId, contactId, flowId, membershipId, flowStepOrder: 1, status: "pending_generation", brainActionType: "nurture_value" });
      return { tenantId, id };
    }
    const message = async (id: string) => (await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, id)))[0];
    const settings = {
      links: { icp_url: "https://fundup.example/icp" },
      link_tracking: { domains: ["fundup.example"] },
      brain: {
        guidelines: "Always write as Umut.",
        text_rules: ["Never say seamless.", { find: "Fundup ", replace: "Fundup AI " }, { forbid: "discount" }],
      },
    };

    it("blocks a draft with a URL outside links and tracked domains", async () => {
      llm.answer = (c) => (c.kind === "draft" ? { subject: "Hi", body_markdown: "Read [this](https://evil.example/x)." } : DEFAULT_ANSWERS[c.kind]);
      const { tenantId, id } = await setup(settings);
      await processContentTick(b.db, new Date(), 20, [tenantId]);
      const m = await message(id);
      expect(m.status).toBe("failed");
      expect(m.statusReason).toBe("link_not_allowed");
      expect(m.brainReasoning).toContain("https://evil.example/x");
      expect(m.bodyHtml).toContain("evil.example");
    });

    it("passes allowed links, applies text rules, gives the model links, rules, guidelines, pinned KB and language", async () => {
      llm.calls.length = 0;
      llm.answer = (c) => (c.kind === "draft" ? { subject: "Fundup update", body_markdown: "Set it up: https://fundup.example/icp" } : DEFAULT_ANSWERS[c.kind]);
      const { tenantId, id } = await setup(settings, "es");
      await b.db.insert(b.schema.kbEntries).values({ tenantId, title: "Product facts", content: "Fundup AI is a feed.", category: "facts", pinned: true, isActive: true });
      await processContentTick(b.db, new Date(), 20, [tenantId]);
      const m = await message(id);
      expect(m.status).toBe("pending_approval");
      expect(m.subject).toBe("Fundup AI update");
      const draft = llm.calls.find((c) => c.kind === "draft")!;
      expect(draft.system).toContain("Always write as Umut.");
      expect(draft.system).toContain('locale "es"');
      expect(draft.user).toContain("icp_url: https://fundup.example/icp");
      expect(draft.user).toContain("Point them at https://fundup.example/icp.");
      expect(draft.user).toContain("Never say seamless.");
      expect(draft.user).toContain("Product facts");
      expect(llm.calls.find((c) => c.kind === "assess")!.system).toContain("Always write as Umut.");
    });

    it("blocks a draft that contains forbidden text", async () => {
      llm.answer = (c) => (c.kind === "draft" ? { subject: "Hi", body_markdown: "Here is a discount for you." } : DEFAULT_ANSWERS[c.kind]);
      const { tenantId, id } = await setup(settings);
      await processContentTick(b.db, new Date(), 20, [tenantId]);
      const m = await message(id);
      expect(m.status).toBe("failed");
      expect(m.statusReason).toBe("text_rule_forbidden");
    });

    it("G29: a {{brain.opening}} slot gets one capped opening line; templates without it make no LLM call", async () => {
      llm.calls.length = 0;
      const long = "Great to see you set things up. ".repeat(20);
      llm.answer = (c) => (c.kind === "opening" ? { opening: long } : DEFAULT_ANSWERS[c.kind]);
      const run = async (body: string) => {
        const tenantId = await b.newTenant({});
        await useFakeLlm(b, tenantId, llm);
        await b.db.insert(b.schema.templates).values({ tenantId, slug: "act", name: "Act", subject: "Next step", bodyHtml: body, isActive: true });
        const flowId = randomUUID();
        const steps = [{ order: 1, action_type: "activation", delay: "0m", template_ref: "act" }];
        await b.db.insert(b.schema.flows).values({
          id: flowId, tenantId, name: "Fixed", triggerType: "event", triggerConfig: { event: "x" }, steps, status: "active",
          compileStatus: "ready", compiledPlan: { trigger: { type: "event", condition: { event: "x" } }, steps }, approvalMode: "require", contentMode: "fixed_content",
        });
        const contactId = randomUUID();
        await b.db.insert(b.schema.contacts).values({ id: contactId, tenantId, externalId: "u", email: "u@example.com", lifecycleState: "engaged", properties: {} });
        const membershipId = randomUUID();
        await b.db.insert(b.schema.flowMemberships).values({ id: membershipId, tenantId, contactId, flowId, enteredAt: new Date(), status: "active" });
        const id = randomUUID();
        await b.db.insert(b.schema.lifecycleMessages).values({ id, tenantId, contactId, flowId, membershipId, flowStepOrder: 1, status: "pending_generation", brainActionType: "activation" });
        await processContentTick(b.db, new Date(), 20, [tenantId]);
        return message(id);
      };
      const plain = await run("<p>Hello</p>");
      expect(plain.status).toBe("pending_approval");
      expect(llm.calls).toHaveLength(0);
      const slotted = await run("<p>{{brain.opening}}</p><p>Hello</p>");
      expect(slotted.status).toBe("pending_approval");
      expect(llm.calls.filter((c) => c.kind === "opening")).toHaveLength(1);
      expect(slotted.openingLine.length).toBeLessThanOrEqual(240);
      expect(slotted.openingLine.startsWith("Great to see you")).toBe(true);
      expect(slotted.bodyHtml).toContain(`<p>${slotted.openingLine}</p>`);
    });
  });
}
