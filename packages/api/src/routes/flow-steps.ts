/**
 * PUT /v1/flows/:id/steps - write a flow's plan as explicit steps (the
 * dashboard's plan editor).
 *
 * Body: { steps: [...], exit_conditions?: [...] } in the shape of a config
 * document's flow steps (docs/guide/CONFIG.md, docs/guide/FLOWS.md): every
 * step field (context, kb_select, choose candidates, sender fields,
 * conditions with all / any / not, ...). Validated with the config document
 * schema (an unknown step key is an error), template references must name
 * templates of the product, and a choose step needs an LLM configuration.
 *
 * On success the plan is stored as compiled (compile_status 'ready'),
 * exactly like a config apply with `steps`. For a prompt-defined flow this
 * replaces the compiled plan until the prompt is compiled again. Archived
 * flows answer 422.
 *
 * Member session (like the other flow edits) or an admin key with `config`.
 */
import { storeFor } from "@claros/store";
import { configFlowSchema } from "@claros/core";
import type { Db } from "../plugins/db.js";
import { RoleRouter, allowAdminKey } from "../http/router.js";
import { serializeFlow } from "./flows.js";

/** Template references of a step list (steps and choose candidates). */
function templateRefs(steps: ReadonlyArray<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (typeof s.template_ref === "string") out.push(s.template_ref);
    for (const c of Array.isArray(s.candidates) ? (s.candidates as Array<Record<string, unknown>>) : []) {
      if (typeof c.template_ref === "string") out.push(c.template_ref);
    }
  }
  return out;
}

export default function flowStepsRoutes() {
  const r = new RoleRouter();

  r.put("/:id/steps", "member", allowAdminKey("config"), async (c) => {
    const body = (c.var.body ?? {}) as Record<string, unknown>;
    // Validate the steps with the config document's flow schema. The trigger
    // is not part of this write; a placeholder keeps the schema satisfied.
    const parsed = configFlowSchema.safeParse({
      slug: "plan",
      name: "plan",
      trigger: { type: "manual" },
      steps: body.steps,
      ...(body.exit_conditions !== undefined ? { exit_conditions: body.exit_conditions } : {}),
    });
    const extra = Object.keys(body).filter((k) => k !== "steps" && k !== "exit_conditions");
    if (!parsed.success || extra.length > 0) {
      const issues = parsed.success ? [] : parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      for (const k of extra) issues.push({ path: k, message: `unknown key '${k}'` });
      return c.json({ error: "Validation failed", issues }, 400);
    }
    const steps = parsed.data.steps as Array<Record<string, unknown>>;
    const exits = parsed.data.exit_conditions ?? [];

    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const flowId = c.req.param("id")!;
    const flow = await storeFor(db).apiFlows.findFlow({ tenantId, id: flowId });
    if (!flow) return c.json({ error: "Flow not found." }, 404);
    if (flow.status === "archived") return c.json({ error: "Cannot update the plan of an archived flow." }, 422);

    const state = await storeFor(db).apiConfig.loadConfigState(tenantId);
    if (!state) return c.json({ error: "Product not found." }, 404);
    const known = new Set(state.templates.map((t) => t.slug));
    const errors: string[] = [];
    for (const ref of templateRefs(steps)) {
      if (!known.has(ref)) errors.push(`unknown template '${ref}'`);
    }
    if (steps.some((s) => s.type === "choose") && !(await storeFor(db).apiFlows.hasActiveLlmConfig(tenantId))) {
      errors.push("a choose step needs an LLM; configure one for this product first");
    }
    if (errors.length > 0) return c.json({ error: errors.join("; "), errors }, 422);

    const now = new Date();
    const compiledPlan = {
      trigger: { type: flow.triggerType, condition: (flow.triggerConfig as Record<string, unknown>) ?? {} },
      steps,
      ...(exits.length > 0 ? { exit_conditions: exits } : {}),
    };
    const updated = await storeFor(db).apiFlows.saveFixedPlan({
      tenantId,
      id: flowId,
      compiledPlan,
      steps,
      compiledAt: now,
      updatedAt: now,
    });
    if (!updated) return c.json({ error: "Flow not found." }, 404);
    return c.json(serializeFlow(updated));
  });

  return r.app;
}
