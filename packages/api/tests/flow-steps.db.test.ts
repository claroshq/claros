/**
 * PUT /v1/flows/:id/steps (the dashboard plan editor): explicit steps with
 * the P5 step fields become the compiled plan; unknown keys, unknown
 * templates, choose without an LLM and archived flows are refused.
 * Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { flows, templates } from "@claros/db/schema";
import { openDb, newProduct, newKey, bearer, cookieJson, dropProduct, app, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let flowId: string;

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "flowsteps");
  const [f] = await db
    .insert(flows)
    .values({ tenantId: p.tenantId, name: "Nudge", triggerType: "event", triggerConfig: { event: "x" }, steps: [], status: "draft" })
    .returning({ id: flows.id });
  flowId = f!.id;
  await db.insert(templates).values({ tenantId: p.tenantId, name: "T", slug: "t-1", subject: "S", bodyHtml: "<p>x</p>" });
});

afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await pool.end();
});

const steps = [
  {
    order: 1, action_type: "nudge", delay: "1d", window_policy: "respect_window",
    brain_instruction: "Point them at the setup page.", expires_after: "2d",
    kb_select: { category: "tips", pick: "oldest_unused" },
    context: [{ source: "leads", mode: "inferred", limit: 3 }], on_empty: "send", on_error: "defer",
    condition: { trait: { key: "plan_tier", op: "eq", value: "pro" } },
  },
  { order: 2, action_type: "follow_up", delay: "3d", template_ref: "t-1" },
];

describe("PUT /v1/flows/:id/steps", () => {
  it("stores the steps as the compiled plan", async () => {
    const a = await app(db);
    const res = await a.inject({ method: "PUT", url: `/v1/flows/${flowId}/steps`, headers: cookieJson(p.memberCookie), payload: { steps, exit_conditions: [{ event: "converted" }] } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.compile_status).toBe("ready");
    expect(body.compiled_plan).toEqual({ trigger: { type: "event", condition: { event: "x" } }, steps, exit_conditions: [{ event: "converted" }] });
    const [row] = await db.select().from(flows).where(eq(flows.id, flowId));
    expect(row!.steps).toEqual(steps);
  });

  it("refuses unknown step keys, unknown templates, choose without an LLM", async () => {
    const a = await app(db);
    const k = await newKey(db, p.tenantId, "admin", ["config"]);
    const bad = await a.inject({ method: "PUT", url: `/v1/flows/${flowId}/steps`, headers: bearer(k), payload: { steps: [{ order: 1, action_type: "a", delay: "0m", bogus: 1 }] } });
    expect(bad.statusCode).toBe(400);
    const extra = await a.inject({ method: "PUT", url: `/v1/flows/${flowId}/steps`, headers: bearer(k), payload: { steps, name: "x" } });
    expect(extra.statusCode).toBe(400);
    const tpl = await a.inject({ method: "PUT", url: `/v1/flows/${flowId}/steps`, headers: bearer(k), payload: { steps: [{ order: 1, action_type: "a", delay: "0m", template_ref: "nope" }] } });
    expect(tpl.statusCode).toBe(422);
    expect(tpl.json().error).toContain("unknown template 'nope'");
    const choose = await a.inject({
      method: "PUT", url: `/v1/flows/${flowId}/steps`, headers: bearer(k),
      payload: { steps: [{ order: 1, action_type: "n", delay: "0m", type: "choose", candidates: [{ action_type: "tip" }] }] },
    });
    expect(choose.statusCode).toBe(422);
    expect(choose.json().error).toContain("LLM");
  });

  it("refuses archived flows and other products' flows", async () => {
    const a = await app(db);
    const other = await newProduct(db, "flowsteps-other");
    try {
      const res = await a.inject({ method: "PUT", url: `/v1/flows/${flowId}/steps`, headers: cookieJson(other.ownerCookie), payload: { steps } });
      expect(res.statusCode).toBe(404);
    } finally {
      await dropProduct(db, other.tenantId);
    }
    await db.update(flows).set({ status: "archived" }).where(eq(flows.id, flowId));
    const res = await a.inject({ method: "PUT", url: `/v1/flows/${flowId}/steps`, headers: cookieJson(p.ownerCookie), payload: { steps } });
    expect(res.statusCode).toBe(422);
  });
});
