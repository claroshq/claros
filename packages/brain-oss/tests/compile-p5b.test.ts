/**
 * P5b: the compile prompt teaches the new condition shapes (combinators,
 * lists, trait / history / first_contact leaves), choose steps and the
 * product-data step fields, lists the product's link names, data sources
 * and KB categories, and compile() accepts the plans a fake LLM returns
 * in those shapes (and still rejects invented shapes).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/compile.js";
import { buildCompileMessages, type CompilePromptContext } from "../src/prompts/compile.js";
import type { LlmProvider, CompletionOptions, CompletionResult } from "../src/providers/types.js";

function fakeLlm(answer: unknown): LlmProvider & { seen: CompletionOptions[] } {
  const seen: CompletionOptions[] = [];
  return {
    seen,
    async complete(opts: CompletionOptions): Promise<CompletionResult> {
      seen.push(opts);
      return { content: JSON.stringify(answer), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    },
  };
}

const ctx: CompilePromptContext = {
  promptSource: "Every day pick one helpful email for engaged users: a tip, a feature, or curated leads when they have matches. Stop once they configured their ICP.",
  triggerType: "segment",
  triggerConfig: { lifecycle_states: ["engaged"] },
  availableTemplates: ["leads"],
  availableKbEntries: [],
  kbCategories: ["tip_trick", "feature_edu"],
  linkNames: ["dashboard_url", "icp_url"],
  dataSources: [{ name: "leads", modes: ["normal", "inferred"] }],
};

describe("compile prompt (P5b)", () => {
  it("teaches combinators, the new leaves, choose steps and the product data fields", () => {
    const [system, user] = buildCompileMessages(ctx);
    for (const s of ['{ "all": [', '{ "any": [', '{ "not": ', '"trait"', '"history"', '"first_contact"', '"type": "choose"', '"candidates"', '"kb_select"', '"context"', '"allowed_links"', '"single_cta"', '"expires_after"', "date_schedule"]) {
      expect(system!.content).toContain(s);
    }
    expect(user!.content).toContain("KB CATEGORIES (valid kb_select.category values):\ntip_trick, feature_edu");
    expect(user!.content).toContain("PRODUCT LINKS (valid allowed_links names):\ndashboard_url, icp_url");
    expect(user!.content).toContain("leads (modes: normal, inferred)");
  });

  it("accepts a choose plan with combinators from the fake LLM", async () => {
    const plan = {
      trigger: { type: "segment", condition: { lifecycle_states: ["engaged"] } },
      steps: [
        {
          order: 1, action_type: "nurture_value", delay: "0m", window_policy: "respect_window", type: "choose", allow_none: true,
          condition: { not: { all: [{ trait: { key: "plan_tier", op: "eq", value: "free" } }, { first_contact: true }] } },
          candidates: [
            { action_type: "nurture_educate", kb_select: { category: "tip_trick" }, cooldown: "14d" },
            { action_type: "digest", when: [{ trait: { key: "icp_match_count", op: "gt", value: 4 } }, { lifecycle_state: "engaged" }], context: [{ source: "leads", mode: "normal", limit: 5 }], template_ref: "leads" },
          ],
          allowed_links: ["dashboard_url"], single_cta: true, expires_after: "1d",
        },
      ],
      exit_conditions: [{ any: [{ event: "icp_configured" }, { trait: { key: "icp_configured", op: "eq", value: true } }] }],
    };
    const llm = fakeLlm(plan);
    const r = await compile(llm, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.steps[0]!.type).toBe("choose");
    expect(llm.seen[0]!.messages[0]!.content).toContain("CHOOSE STEPS");
  });

  it("still rejects invented condition shapes", async () => {
    const llm = fakeLlm({
      trigger: { type: "segment", condition: {} },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0m", condition: { either: [{ lifecycle_state: "engaged" }] } }],
    });
    const r = await compile(llm, ctx);
    expect(r.ok).toBe(false);
  });
});
