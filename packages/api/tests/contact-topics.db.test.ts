/**
 * PUT /v1/contacts/:id/topics on Postgres: the team sets a contact's topic
 * subscriptions (source "admin"), changes of effective status emit
 * contact.subscribed / contact.unsubscribed, transactional and unknown
 * topics are refused, and other products' contacts are not found.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { webhookEndpoints, webhookOutbox } from "@claros/db/schema";
import { openDb, newProduct, newMessage, app as buildTestApp, dropProduct, cookieJson, type TestDb, type TestProduct } from "./support/product.js";
import type { ClarosApp } from "../src/app.js";

let pool: Awaited<ReturnType<typeof openDb>>["pool"];
let db: TestDb;
let a: ClarosApp;
const products: TestProduct[] = [];

beforeAll(async () => {
  ({ pool, db } = openDb());
  a = await buildTestApp(db);
});

afterAll(async () => {
  for (const p of products) await dropProduct(db, p.tenantId);
  await pool.end();
});

async function setup(label: string) {
  const p = await newProduct(db, label);
  products.push(p);
  const mk = (slug: string, kind: string, default_subscribed = true) =>
    a.inject({ method: "POST", url: "/v1/topics", headers: cookieJson(p.ownerCookie), payload: { slug, name: slug, kind, default_subscribed } });
  expect((await mk("news", "marketing")).statusCode).toBe(201);
  expect((await mk("beta", "lifecycle", false)).statusCode).toBe(201);
  expect((await mk("receipts", "transactional")).statusCode).toBe(201);
  const { contactId } = await newMessage(db, p.tenantId);
  const [ep] = await db.insert(webhookEndpoints).values({ tenantId: p.tenantId, slug: "hooks", url: "http://127.0.0.1:9/x", events: ["contact.subscribed", "contact.unsubscribed"] }).returning({ id: webhookEndpoints.id });
  return { p, contactId, endpointId: ep!.id };
}

const put = (p: TestProduct, contactId: string, topics: unknown, cookie = p.memberCookie) =>
  a.inject({ method: "PUT", url: `/v1/contacts/${contactId}/topics`, headers: cookieJson(cookie), payload: { topics } });

describe("PUT /v1/contacts/:id/topics", () => {
  it("sets statuses with source admin and emits events for real changes only", async () => {
    const { p, contactId, endpointId } = await setup("ct-set");
    const res = await put(p, contactId, { news: false, beta: true });
    expect(res.statusCode).toBe(200);
    const byslug = Object.fromEntries(res.json().topics.map((t: { slug: string }) => [t.slug, t]));
    expect(byslug.news).toMatchObject({ status: "unsubscribed", default: false, source: "admin" });
    expect(byslug.beta).toMatchObject({ status: "subscribed", default: false, source: "admin" });
    expect(byslug.receipts).toMatchObject({ kind: "transactional", default: true });

    // The contact page shows the same statuses.
    const detail = (await a.inject({ method: "GET", url: `/v1/contacts/${contactId}`, headers: { cookie: p.memberCookie } })).json();
    expect(detail.topics.find((t: { slug: string }) => t.slug === "news")).toMatchObject({ status: "unsubscribed", source: "admin" });

    // Setting the same values again changes nothing and emits nothing more.
    expect((await put(p, contactId, { news: false, beta: true })).statusCode).toBe(200);
    const out = await db.select().from(webhookOutbox).where(eq(webhookOutbox.endpointId, endpointId));
    const events = out.map((o) => [o.event, (o.payload as { topic: string; source: string }).topic, (o.payload as { source: string }).source]).sort();
    expect(events).toEqual([["contact.subscribed", "beta", "admin"], ["contact.unsubscribed", "news", "admin"]]);
  });

  it("refuses transactional and unknown topics and changes nothing", async () => {
    const { p, contactId } = await setup("ct-bad");
    const t = await put(p, contactId, { news: false, receipts: false });
    expect(t.statusCode).toBe(400);
    expect(t.json().error).toContain("transactional");
    expect((await put(p, contactId, { nope: true })).statusCode).toBe(400);
    expect((await put(p, contactId, {})).statusCode).toBe(400);
    const detail = (await a.inject({ method: "GET", url: `/v1/contacts/${contactId}`, headers: { cookie: p.memberCookie } })).json();
    expect(detail.topics.find((x: { slug: string }) => x.slug === "news")).toMatchObject({ status: "subscribed", default: true });
  });

  it("does not reach another product's contact", async () => {
    const { contactId } = await setup("ct-mine");
    const other = await newProduct(db, "ct-theirs");
    products.push(other);
    expect((await put(other, contactId, { news: false })).statusCode).toBe(404);
  });
});
