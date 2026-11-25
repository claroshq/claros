/** Config as code (G2): schema, JSON Schema currency, planning. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clarosConfigSchema, configJsonSchema, planConfig, sameJson, type ConfigState } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("JSON Schema", () => {
  it("docs/reference/claros.config.schema.json is current (node scripts/gen-config-schema.mjs)", () => {
    const committed = readFileSync(join(here, "../../../docs/reference/claros.config.schema.json"), "utf8");
    expect(committed).toBe(`${JSON.stringify(configJsonSchema(clarosConfigSchema), null, 2)}\n`);
  });
});

describe("schema", () => {
  it("rejects duplicates, flows without steps or prompt, unknown keys", () => {
    const flow = { slug: "f", name: "F", trigger: { type: "event", event: "x" }, steps: [{ order: 1, action_type: "a", delay: "0m" }] };
    expect(clarosConfigSchema.safeParse({ flows: [flow] }).success).toBe(true);
    expect(clarosConfigSchema.safeParse({ flows: [flow, flow] }).success).toBe(false);
    expect(clarosConfigSchema.safeParse({ flows: [{ ...flow, steps: undefined }] }).success).toBe(false);
    expect(clarosConfigSchema.safeParse({ flows: [{ ...flow, prompt: "x" }] }).success).toBe(false);
    expect(clarosConfigSchema.safeParse({ flows: [{ ...flow, trigger: { type: "event" } }] }).success).toBe(false);
    expect(clarosConfigSchema.safeParse({ bogus: 1 }).success).toBe(false);
    expect(clarosConfigSchema.safeParse({ webhooks: [{ slug: "w", url: "ftp://x", events: ["message.sent"] }] }).success).toBe(false);
    expect(clarosConfigSchema.safeParse({ webhooks: [{ slug: "w", url: "https://x.example", events: ["message.nope"] }] }).success).toBe(false);
  });
});

function emptyState(): ConfigState {
  return { settings: {}, locale: null, configVersion: 3, topics: [], templates: [], flows: [], transports: [], endpoints: [] };
}
let n = 0;
const deps = { newId: () => `id-${++n}`, newSecret: () => "whsec_generated", readSecret: (e: string) => e.replace(/^enc:/, "") };

describe("planConfig", () => {
  it("creates everything on an empty product, resolving topic slugs to new ids", () => {
    const plan = planConfig(
      clarosConfigSchema.parse({
        settings: { locale: "en", links: { icp_url: "https://app.example.com/icp" } },
        topics: [{ slug: "account", name: "Account", kind: "transactional" }],
        templates: [{ slug: "t1", name: "T1", subject: "S", body_html: "<p>x</p>" }],
        flows: [{ slug: "dunning", name: "Dunning", flow_class: "critical", topic: "account", trigger: { type: "event", event: "payment_failed" }, steps: [{ order: 1, action_type: "dunning", delay: "0m", template_ref: "t1" }] }],
        webhooks: [{ slug: "app", url: "https://app.example.com/hook", events: ["message.sent"] }],
      }),
      emptyState(),
      deps,
    );
    expect(plan.errors).toEqual([]);
    expect(plan.changes.map((c) => `${c.kind}:${c.key}:${c.action}`)).toEqual([
      "setting:links:create", "setting:locale:create", "topic:account:create", "template:t1:create", "flow:dunning:create", "webhook:app:create",
    ]);
    const topicOp = plan.ops.find((o) => o.op === "upsertTopic")!;
    const flowOp = plan.ops.find((o) => o.op === "upsertFlow")!;
    expect(flowOp.op === "upsertFlow" && flowOp.values).toMatchObject({
      topicId: topicOp.id, contentMode: "fixed_content", flowClass: "critical", status: "active", compileStatus: "ready",
      triggerType: "event", triggerConfig: { event: "payment_failed" },
    });
    expect(plan.generatedSecrets).toEqual({ app: "whsec_generated" });
  });

  it("reports unknown topics, templates and transports and the cloudflare default route", () => {
    const state = emptyState();
    state.transports = [{ id: "cf", name: "cf", kind: "cloudflare", isActive: true }];
    const plan = planConfig(
      clarosConfigSchema.parse({
        transports: { routing: { default: "cf", transactional: "missing" } },
        flows: [
          { slug: "a", name: "A", topic: "nope", trigger: { type: "manual" }, steps: [{ order: 1, action_type: "x", delay: "0m" }] },
          { slug: "b", name: "B", trigger: { type: "manual" }, steps: [{ order: 1, action_type: "x", delay: "0m", template_ref: "ghost" }] },
        ],
      }),
      state,
      deps,
    );
    expect(plan.errors).toEqual([
      "transports.routing.transactional: no active transport named 'missing'",
      expect.stringContaining("transports.routing.default: 'cf' is a cloudflare transport"),
      "flows.a: unknown topic 'nope'",
      "flows.b: step 1 references unknown template 'ghost'",
    ]);
  });

  it("is empty when the state already matches (jsonb key order does not matter)", () => {
    const state = emptyState();
    state.settings = { links: { b: "https://b.example", a: "https://a.example" }, transport_routing: { default: "r1" } };
    state.transports = [{ id: "r1", name: "resend", kind: "resend", isActive: true }];
    state.endpoints = [{ id: "e1", slug: "app", kind: "webhook", url: "https://x.example/h", events: ["message.sent", "flow.enrolled"], enabled: true, secret: "enc:whsec_abcdefghijklmnop", config: null }];
    const plan = planConfig(
      clarosConfigSchema.parse({
        settings: { links: { a: "https://a.example", b: "https://b.example" } },
        transports: { routing: { default: "resend" } },
        webhooks: [{ slug: "app", url: "https://x.example/h", events: ["flow.enrolled", "message.sent"], secret: "whsec_abcdefghijklmnop" }],
      }),
      state,
      deps,
    );
    expect(plan).toMatchObject({ changes: [], ops: [], errors: [] });
  });

  it("prune archives unlisted flows, deletes unlisted webhooks and unused templates, refuses topics in use", () => {
    const state = emptyState();
    state.topics = [{ id: "tp", slug: "old", name: "Old", kind: "marketing", description: null, defaultSubscribed: true }];
    state.templates = [
      { id: "t1", slug: "unused", name: "U", subject: "s", bodyHtml: "b", bodyText: null, category: null, isActive: true },
    ];
    state.flows = [{
      id: "f1", slug: null, name: "Dashboard flow", description: null, status: "active", triggerType: "manual", triggerConfig: {},
      steps: [], compiledPlan: null, promptSource: null, contentMode: "ai_drafted", approvalMode: "require", flowClass: "nurture",
      priority: 0, reentryPolicy: "cooldown", reentryCooldownDays: 30, topicId: "tp",
    }];
    state.endpoints = [{ id: "e1", slug: "gone", kind: "webhook", url: "https://x.example", events: ["message.sent"], enabled: true, secret: null, config: null }];
    const plan = planConfig(clarosConfigSchema.parse({ prune: true, flows: [], templates: [], webhooks: [], topics: [] }), state, deps);
    expect(plan.changes.map((c) => `${c.kind}:${c.key}:${c.action}`)).toEqual(["flow:id:f1:archive", "webhook:gone:delete", "template:unused:delete"]);
    expect(plan.errors).toEqual(["prune: topic 'old' is used by a flow; keep it in the document"]);
    // Without prune nothing is removed.
    expect(planConfig(clarosConfigSchema.parse({ flows: [], webhooks: [] }), state, deps).ops).toEqual([]);
  });

  it("updates only changed fields and keeps a prompt flow's compiled plan when the prompt is unchanged", () => {
    const state = emptyState();
    state.flows = [{
      id: "f1", slug: "winback", name: "Winback", description: null, status: "paused", triggerType: "lifecycle_transition", triggerConfig: { to: "churned" },
      steps: [{ order: 1 }], compiledPlan: { steps: [{ order: 1 }] }, promptSource: "Win them back", contentMode: "ai_drafted", approvalMode: "require",
      flowClass: "nurture", priority: 0, reentryPolicy: "cooldown", reentryCooldownDays: 30, topicId: null,
    }];
    const same = planConfig(clarosConfigSchema.parse({ flows: [{ slug: "winback", name: "Winback", trigger: { type: "lifecycle_transition", to: "churned" }, prompt: "Win them back" }] }), state, deps);
    expect(same.ops).toEqual([]);
    const renamed = planConfig(clarosConfigSchema.parse({ flows: [{ slug: "winback", name: "Win back", approval_mode: "auto", trigger: { type: "lifecycle_transition", to: "churned" }, prompt: "Win them back" }] }), state, deps);
    expect(renamed.changes).toEqual([{ kind: "flow", key: "winback", action: "update", fields: ["name", "approvalMode"] }]);
    const op = renamed.ops[0]!;
    expect(op.op === "upsertFlow" && op).toMatchObject({ compile: false, values: { compiledPlan: { steps: [{ order: 1 }] }, compileStatus: null, status: "paused" } });
    const reprompt = planConfig(clarosConfigSchema.parse({ flows: [{ slug: "winback", name: "Winback", trigger: { type: "lifecycle_transition", to: "churned" }, prompt: "New prompt" }] }), state, deps);
    expect(reprompt.ops[0]).toMatchObject({ op: "upsertFlow", compile: true, values: { compiledPlan: null, compileStatus: "pending" } });
  });

  it("sameJson ignores key order and undefined", () => {
    expect(sameJson({ a: 1, b: { c: [1, { d: 2, e: undefined }] } }, { b: { c: [1, { d: 2 }] }, a: 1 })).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
  });
});

describe("docs/guide/CONFIG.md", () => {
  it("the complete example is a valid document", () => {
    const md = readFileSync(join(here, "../../../docs/guide/CONFIG.md"), "utf8");
    const block = /## A complete example\s+```json\n([\s\S]*?)\n```/.exec(md)![1]!;
    const parsed = clarosConfigSchema.safeParse(JSON.parse(block));
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });
});

describe("settings.lifecycle.engagement_events", () => {
  it("accepts a list of event names and rejects empty names", () => {
    const ok = clarosConfigSchema.safeParse({ settings: { lifecycle: { engagement_events: ["project_created"] } } });
    expect(ok.success).toBe(true);
    expect(clarosConfigSchema.safeParse({ settings: { lifecycle: { engagement_events: [] } } }).success).toBe(true);
    expect(clarosConfigSchema.safeParse({ settings: { lifecycle: { engagement_events: [""] } } }).success).toBe(false);
  });
});
