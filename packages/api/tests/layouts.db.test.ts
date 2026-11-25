/**
 * Email templates on Postgres (/v1/layouts): built-ins are listed with the
 * one in use, custom templates are created, changed, used and deleted with
 * validation, brand.template is validated in the settings API, and the
 * studio turn calls the product's LLM and returns a checked template.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { llmConfigs } from "@claros/db/schema";
import { encrypt, parseEncryptionKey } from "@claros/adapters";
import { BUILTIN_LAYOUTS } from "@claros/core";
import { openDb, newProduct, newKey, newMessage, app as buildTestApp, dropProduct, bearer, cookieJson, type TestDb, type TestProduct } from "./support/product.js";
import type { ClarosApp } from "../src/app.js";

let pool: Awaited<ReturnType<typeof openDb>>["pool"];
let db: TestDb;
let a: ClarosApp;
const products: TestProduct[] = [];

async function product(label: string): Promise<TestProduct> {
  const p = await newProduct(db, label);
  products.push(p);
  return p;
}

const classic = BUILTIN_LAYOUTS.find((b) => b.key === "classic")!;
const source = classic.source.replace("padding:24px 40px 40px 40px", "padding:32px 40px 48px 40px");

const req = (p: TestProduct, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  a.inject({ method, url, headers: payload === undefined ? { cookie: p.ownerCookie } : cookieJson(p.ownerCookie), ...(payload === undefined ? {} : { payload }) });

beforeAll(async () => {
  ({ pool, db } = openDb());
  a = await buildTestApp(db);
});

afterAll(async () => {
  for (const p of products) {
    await db.execute(sql`DELETE FROM email_layouts WHERE tenant_id = ${p.tenantId}::uuid`);
    await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id = ${p.tenantId}::uuid`);
    await db.execute(sql`DELETE FROM tenant_daily_usage WHERE tenant_id = ${p.tenantId}::uuid`);
    await dropProduct(db, p.tenantId);
  }
  await pool.end();
});

describe("GET /v1/layouts", () => {
  it("lists the built-ins with classic in use, and previews on request", async () => {
    const p = await product("layouts-list");
    const res = await req(p, "GET", "/v1/layouts");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.active).toBe("classic");
    expect(body.templates.map((t: { ref: string }) => t.ref)).toEqual(BUILTIN_LAYOUTS.map((b) => b.key));
    expect(body.templates[0]).toMatchObject({ kind: "builtin", in_use: true, width: "narrow" });
    expect(body.templates[0].preview_html).toBeUndefined();

    const withPreviews = (await req(p, "GET", "/v1/layouts?previews=true")).json();
    expect(withPreviews.templates[0].preview_html).toContain("Your workspace is ready");
  });

  it("follows brand.layout when no template is chosen", async () => {
    const p = await product("layouts-legacy");
    await a.inject({ method: "PATCH", url: "/v1/settings/tenant", headers: cookieJson(p.ownerCookie), payload: { brand: { layout: "wide" } } });
    expect((await req(p, "GET", "/v1/layouts")).json().active).toBe("wide");
  });

  it("returns one built-in with its source, findings and preview", async () => {
    const p = await product("layouts-one");
    const res = await req(p, "GET", "/v1/layouts/banner");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.template).toMatchObject({ ref: "banner", kind: "builtin", width: "narrow" });
    expect(body.template.source).toContain("{{compliance_footer}}");
    expect(body.findings.filter((f: { severity: string }) => f.severity !== "info")).toEqual([]);
    expect(body.preview_html).toContain("<!DOCTYPE html>");
    expect((await req(p, "GET", "/v1/layouts/nope")).statusCode).toBe(404);
  });
});

describe("custom templates", () => {
  it("creates, reads, updates, uses and deletes a template", async () => {
    const p = await product("layouts-crud");
    const created = await req(p, "POST", "/v1/layouts", { name: "Roomy", width: "narrow", source, based_on: "classic" });
    expect(created.statusCode).toBe(201);
    const id = created.json().template.id as string;
    expect(created.json().template).toMatchObject({ kind: "custom", name: "Roomy", based_on: "classic", in_use: false });

    const got = (await req(p, "GET", `/v1/layouts/${id}`)).json();
    expect(got.template.source).toBe(source);

    const renamed = await req(p, "PUT", `/v1/layouts/${id}`, { name: "Roomy 2" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().template).toMatchObject({ name: "Roomy 2" });

    const used = await req(p, "PUT", "/v1/layouts/active", { template: id });
    expect(used.json()).toEqual({ active: id });
    const list = (await req(p, "GET", "/v1/layouts")).json();
    expect(list.active).toBe(id);
    expect(list.templates.find((t: { ref: string }) => t.ref === id).in_use).toBe(true);
    const tenant = (await req(p, "GET", "/v1/settings/tenant")).json().tenant;
    expect(tenant.brand.template).toBe(id);

    expect((await req(p, "DELETE", `/v1/layouts/${id}`)).statusCode).toBe(409);
    await req(p, "PUT", "/v1/layouts/active", { template: "letter" });
    expect((await req(p, "DELETE", `/v1/layouts/${id}`)).statusCode).toBe(204);
    expect((await req(p, "GET", `/v1/layouts/${id}`)).statusCode).toBe(404);
  });

  it("refuses templates with errors and lists the findings", async () => {
    const p = await product("layouts-invalid");
    const res = await req(p, "POST", "/v1/layouts", { name: "Bad", width: "narrow", source: source.replace("{{compliance_footer}}", "") });
    expect(res.statusCode).toBe(422);
    expect(res.json().findings.map((f: { rule: string }) => f.rule)).toContain("missing_compliance_footer");
    const ok = (await req(p, "POST", "/v1/layouts", { name: "Ok", width: "narrow", source })).json().template.id;
    const bad = await req(p, "PUT", `/v1/layouts/${ok}`, { source: source.replace("<body", "<body><script>x</script><body") });
    expect(bad.statusCode).toBe(422);
  });

  it("does not change or delete built-ins and refuses unknown active templates", async () => {
    const p = await product("layouts-builtin");
    expect((await req(p, "PUT", "/v1/layouts/classic", { name: "x" })).statusCode).toBe(409);
    expect((await req(p, "DELETE", "/v1/layouts/classic")).statusCode).toBe(409);
    expect((await req(p, "PUT", "/v1/layouts/active", { template: "nope" })).statusCode).toBe(404);
    expect((await req(p, "PUT", "/v1/layouts/active", { template: "3b1f0c52-1d2e-4c55-9a8e-2f4f0f6c9d10" })).statusCode).toBe(404);
  });

  it("keeps products apart", async () => {
    const p = await product("layouts-mine");
    const other = await product("layouts-theirs");
    const id = (await req(p, "POST", "/v1/layouts", { name: "Mine", width: "wide", source })).json().template.id;
    expect((await req(other, "GET", `/v1/layouts/${id}`)).statusCode).toBe(404);
    expect((await req(other, "PUT", "/v1/layouts/active", { template: id })).statusCode).toBe(404);
    expect((await req(other, "DELETE", `/v1/layouts/${id}`)).statusCode).toBe(404);
  });

  it("accepts an admin key with the config scope", async () => {
    const p = await product("layouts-key");
    const key = await newKey(db, p.tenantId, "admin", ["config"]);
    const res = await a.inject({ method: "POST", url: "/v1/layouts", headers: bearer(key, { "content-type": "application/json" }), payload: { name: "Via key", width: "narrow", source } });
    expect(res.statusCode).toBe(201);
  });
});

describe("PATCH /v1/settings/tenant brand.template", () => {
  it("accepts built-in keys and the product's own templates only", async () => {
    const p = await product("layouts-settings");
    const patch = (template: unknown) => a.inject({ method: "PATCH", url: "/v1/settings/tenant", headers: cookieJson(p.ownerCookie), payload: { brand: { template } } });
    expect((await patch("broadsheet")).json().tenant.brand.template).toBe("broadsheet");
    expect((await patch("nope")).statusCode).toBe(400);
    expect((await patch("3b1f0c52-1d2e-4c55-9a8e-2f4f0f6c9d10")).statusCode).toBe(400);
    expect((await patch(null)).json().tenant.brand.template).toBeNull();
  });
});

describe("POST /v1/layouts/preview", () => {
  it("renders a working copy with the product brand and returns findings", async () => {
    const p = await product("layouts-preview");
    const res = await req(p, "POST", "/v1/layouts/preview", { source: source.replace("<body", '<body style="display:flex"'), width: "narrow" });
    expect(res.statusCode).toBe(200);
    expect(res.json().html).toContain("Your workspace is ready");
    expect(res.json().findings.map((f: { rule: string }) => f.rule)).toContain("flexbox");
  });
});

describe("POST /v1/layouts/assist", () => {
  it("answers 422 without an LLM provider", async () => {
    const p = await product("layouts-nollm");
    const res = await req(p, "POST", "/v1/layouts/assist", { source, width: "narrow", message: "more space" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain("AI providers");
  });

  it("runs one studio turn with the product's LLM and counts its tokens", async () => {
    const p = await product("layouts-assist");
    // CI has no ENCRYPTION_KEY; use a test key for this test only.
    const savedKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const key = parseEncryptionKey(process.env.ENCRYPTION_KEY);
    await db.insert(llmConfigs).values({
      tenantId: p.tenantId,
      provider: "openai",
      config: encrypt(JSON.stringify({ apiKey: "sk-test", baseUrl: "https://llm.example/v1", model: "m" }), key),
      isActive: true,
    });
    const changed = source.replace("font-size:15px", "font-size:16px");
    const content = `<reply>Body text is 16px now.</reply>\n<decision>applied</decision>\n<template>\n${changed}\n</template>`;
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 } }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const res = await req(p, "POST", "/v1/layouts/assist", { source, width: "narrow", message: "bigger text", history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ decision: "applied", reply: "Body text is 16px now.", source: changed, new_findings: [] });
      expect(res.json().preview_html).toContain("font-size:16px");
      const sent = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(sent.messages[0].role).toBe("system");
      expect(sent.messages).toHaveLength(4);
      expect(String(fetchMock.mock.calls[0]![0])).toBe("https://llm.example/v1/chat/completions");
    } finally {
      globalThis.fetch = original;
      if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = savedKey;
    }
    const usage = await db.execute(sql`SELECT llm_tokens FROM tenant_daily_usage WHERE tenant_id = ${p.tenantId}::uuid`);
    expect(Number((usage.rows[0] as { llm_tokens: number }).llm_tokens)).toBe(1000);
  });

  it("is for owners", async () => {
    const p = await product("layouts-member");
    const res = await a.inject({ method: "POST", url: "/v1/layouts/assist", headers: { "content-type": "application/json", cookie: p.memberCookie }, payload: { source, width: "narrow", message: "x" } });
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe("previews follow the product's template", () => {
  it("renders approval drafts in the custom template in use", async () => {
    const p = await product("layouts-approvals");
    const custom = '<!DOCTYPE html><html><body><div id="studio-shell">{{brand_name}}</div>{{body}}{{compliance_footer}}</body></html>';
    const id = (await req(p, "POST", "/v1/layouts", { name: "Mine", width: "narrow", source: custom })).json().template.id;
    await req(p, "PUT", "/v1/layouts/active", { template: id });
    await newMessage(db, p.tenantId);
    const res = await req(p, "GET", "/v1/messages?status=pending_approval");
    expect(res.statusCode).toBe(200);
    const msg = res.json().messages[0];
    expect(msg.preview_html).toContain('<div id="studio-shell">');
    expect(msg.preview_html).toContain("<p>Hi</p>");
  });
});

describe("per-flow email template", () => {
  const flowBody = (extra: Record<string, unknown> = {}) => ({
    name: "Welcome",
    trigger_type: "event",
    trigger_config: { event: "signed_up" },
    steps: [{ order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" }],
    ...extra,
  });

  it("sets, changes, validates and clears a flow's email_template", async () => {
    const p = await product("flow-tpl");
    const created = await req(p, "POST", "/v1/flows", flowBody({ email_template: "letter" }));
    expect(created.statusCode).toBe(201);
    const flowId = created.json().flow?.id ?? created.json().id;
    const flowOf = (r: { json(): Record<string, unknown> }) => ((r.json().flow ?? r.json()) as { email_template: string | null });
    expect(flowOf(created).email_template).toBe("letter");

    const customId = (await req(p, "POST", "/v1/layouts", { name: "Mine", width: "narrow", source })).json().template.id;
    const patched = await a.inject({ method: "PATCH", url: `/v1/flows/${flowId}`, headers: cookieJson(p.ownerCookie), payload: { email_template: customId } });
    expect(patched.statusCode).toBe(200);
    expect(flowOf(patched).email_template).toBe(customId);

    expect((await a.inject({ method: "PATCH", url: `/v1/flows/${flowId}`, headers: cookieJson(p.ownerCookie), payload: { email_template: "nope" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "PATCH", url: `/v1/flows/${flowId}`, headers: cookieJson(p.ownerCookie), payload: { email_template: "3b1f0c52-1d2e-4c55-9a8e-2f4f0f6c9d10" } })).statusCode).toBe(400);
    expect((await req(p, "POST", "/v1/flows", flowBody({ name: "Bad", email_template: "nope" }))).statusCode).toBe(400);

    // The Templates list counts flows; a template a flow uses cannot be deleted.
    const list = (await req(p, "GET", "/v1/layouts")).json();
    expect(list.templates.find((t: { ref: string }) => t.ref === customId).flow_count).toBe(1);
    const del = await req(p, "DELETE", `/v1/layouts/${customId}`);
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toContain('"Welcome"');

    const cleared = await a.inject({ method: "PATCH", url: `/v1/flows/${flowId}`, headers: cookieJson(p.ownerCookie), payload: { email_template: null } });
    expect(flowOf(cleared).email_template).toBeNull();
    expect((await req(p, "DELETE", `/v1/layouts/${customId}`)).statusCode).toBe(204);
  });

  it("renders approval drafts in their flow's template, others in the product's", async () => {
    const p = await product("flow-tpl-preview");
    const custom = '<!DOCTYPE html><html><body><div id="flow-shell">{{brand_name}}</div>{{body}}{{compliance_footer}}</body></html>';
    const id = (await req(p, "POST", "/v1/layouts", { name: "Flow one", width: "narrow", source: custom })).json().template.id;
    const a1 = await newMessage(db, p.tenantId);
    const a2 = await newMessage(db, p.tenantId);
    await a.inject({ method: "PATCH", url: `/v1/flows/${a1.flowId}`, headers: cookieJson(p.ownerCookie), payload: { email_template: id } });
    await req(p, "PUT", "/v1/layouts/active", { template: "letter" });
    const msgs = (await req(p, "GET", "/v1/messages?status=pending_approval")).json().messages as Array<{ id: string; preview_html: string }>;
    const m1 = msgs.find((m) => m.id === a1.messageId)!;
    const m2 = msgs.find((m) => m.id === a2.messageId)!;
    expect(m1.preview_html).toContain('<div id="flow-shell">');
    expect(m2.preview_html).not.toContain("flow-shell");
    expect(m2.preview_html).toContain("Georgia");
  });
});

