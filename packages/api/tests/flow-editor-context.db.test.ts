/**
 * The flow editor's server side: GET /v1/flows/editor-context (pickers for
 * links, context sources, date traits and templates), PUT
 * /v1/email-templates/by-slug/:slug (a step's fixed copy) and the flow's
 * config slug in GET /v1/flows/:id. Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { flows, templates, tenants } from "@claros/db/schema";
import { openDb, newProduct, cookieJson, dropProduct, app, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let other: TestProduct;
let flowId: string;

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "flowctx");
  other = await newProduct(db, "flowctx-other");
  await db
    .update(tenants)
    .set({
      settings: {
        links: { setup_url: "https://app.example.com/setup", bad: 3 },
        data_sources: { leads: { url: "https://app.example.com/ctx", secret: "s3cret-value" } },
        date_traits: ["trial_ends_at"],
      },
    })
    .where(eq(tenants.id, p.tenantId));
  await db.insert(templates).values({ tenantId: p.tenantId, name: "Welcome", slug: "welcome", subject: "Hi", bodyHtml: "<p>x</p>" });
  const [f] = await db
    .insert(flows)
    .values({
      tenantId: p.tenantId, name: "Welcome", slug: "welcome_flow", triggerType: "event", triggerConfig: { event: "signed_up" }, status: "draft",
      steps: [{ order: 1, action_type: "welcome", delay: "0m", template_ref: "welcome" }],
    })
    .returning({ id: flows.id });
  flowId = f!.id;
});

afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await dropProduct(db, other.tenantId);
  await pool.end();
});

describe("GET /v1/flows/editor-context", () => {
  it("lists link names, context source names (no secrets), date traits and templates with their flows", async () => {
    const a = await app(db);
    const res = await a.inject({ method: "GET", url: "/v1/flows/editor-context", headers: cookieJson(p.memberCookie) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.links).toEqual([{ name: "setup_url", url: "https://app.example.com/setup" }]);
    expect(body.data_sources).toEqual(["leads"]);
    expect(body.date_traits).toEqual(["trial_ends_at"]);
    expect(body.has_llm).toBe(false);
    expect(body.templates).toEqual([{ slug: "welcome", name: "Welcome", subject: "Hi", used_by_flows: [flowId] }]);
    expect(res.body).not.toContain("s3cret-value");
  });

  it("is per product", async () => {
    const a = await app(db);
    const res = await a.inject({ method: "GET", url: "/v1/flows/editor-context", headers: cookieJson(other.memberCookie) });
    expect(res.statusCode).toBe(200);
    expect(res.json().templates).toEqual([]);
  });
});

describe("GET /v1/flows/:id slug", () => {
  it("carries the config slug", async () => {
    const a = await app(db);
    const res = await a.inject({ method: "GET", url: `/v1/flows/${flowId}`, headers: cookieJson(p.memberCookie) });
    expect(res.json().slug).toBe("welcome_flow");
  });
});

describe("PUT /v1/email-templates/by-slug/:slug", () => {
  it("creates a template, then updates it and keeps its name", async () => {
    const a = await app(db);
    const created = await a.inject({
      method: "PUT", url: "/v1/email-templates/by-slug/flow-abc-1", headers: cookieJson(p.memberCookie),
      payload: { name: "Onboarding - email 1", subject: " Welcome ", body_html: "<p>Hello</p>" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().template).toMatchObject({ slug: "flow-abc-1", name: "Onboarding - email 1", subject: "Welcome", body_text: null });

    const updated = await a.inject({
      method: "PUT", url: "/v1/email-templates/by-slug/flow-abc-1", headers: cookieJson(p.memberCookie),
      payload: { subject: "Welcome again", body_html: "<p>Hi</p>", body_text: "Hi" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().template).toMatchObject({ name: "Onboarding - email 1", subject: "Welcome again", body_html: "<p>Hi</p>", body_text: "Hi" });

    const theirs = await a.inject({ method: "GET", url: "/v1/email-templates", headers: cookieJson(other.memberCookie) });
    expect(theirs.json().templates).toEqual([]);
  });

  it("refuses a bad slug and empty content", async () => {
    const a = await app(db);
    const slug = await a.inject({ method: "PUT", url: "/v1/email-templates/by-slug/Bad%20Slug", headers: cookieJson(p.memberCookie), payload: { subject: "a", body_html: "b" } });
    expect(slug.statusCode).toBe(400);
    const empty = await a.inject({ method: "PUT", url: "/v1/email-templates/by-slug/ok-slug", headers: cookieJson(p.memberCookie), payload: { subject: " ", body_html: "b" } });
    expect(empty.statusCode).toBe(400);
    const missing = await a.inject({ method: "PUT", url: "/v1/email-templates/by-slug/ok-slug", headers: cookieJson(p.memberCookie), payload: { subject: "a" } });
    expect(missing.statusCode).toBe(400);
  });
});
