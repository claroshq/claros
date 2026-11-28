/**
 * Webhook and analytics delivery (G5, G30) with a fake HTTP client: Standard
 * Webhooks signatures, the StatsRaven ingest request, the pending-approval
 * count, retries with backoff, dead rows. Requires local Postgres.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { tenants, contacts, flows, flowMemberships, lifecycleMessages, webhookEndpoints, webhookOutbox } from "@claros/db/schema";
import { encrypt, parseEncryptionKey } from "@claros/adapters";
import { verifyWebhook, WEBHOOK_MAX_ATTEMPTS } from "@claros/core";
import { processWebhookTick, statsravenIngestUrl, type FetchFn } from "../src/webhooks.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[webhooks.test] DATABASE_URL is not set.");
const KEY = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="; // tests only
const SECRET = "whsec_dGVzdC1zZWNyZXQtZm9yLXdlYmhvb2tzLW9ubHk=";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let tenantId: string;
let slug: string;
let messageId: string;
let contactExt: string;

type Call = { url: string; headers: Record<string, string>; body: string };
/** Records only this test product's requests (other products' leftover rows may be due too). */
function fakeFetch(status: number | ((c: Call) => number), calls: Call[]): FetchFn {
  return async (url, init) => {
    const call = { url, headers: init.headers, body: init.body };
    if (init.body.includes(slug)) calls.push(call);
    const s = typeof status === "function" ? status(call) : status;
    return { status: s, text: async () => (s >= 300 ? "nope" : "") };
  };
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL });
  db = drizzle(pool);
  slug = `test-webhooks-${randomUUID().slice(0, 8)}`;
  const [t] = await db.insert(tenants).values({ name: "Webhooks", slug }).returning({ id: tenants.id });
  tenantId = t!.id;
  contactExt = `user-${randomUUID().slice(0, 6)}`;
  const [c] = await db.insert(contacts).values({ tenantId, externalId: contactExt, email: "w@example.com", name: "Wanda", properties: { plan: "pro" }, lifecycleState: "engaged" }).returning({ id: contacts.id });
  const [f] = await db.insert(flows).values({ tenantId, name: "Welcome", slug: "welcome", triggerType: "manual", triggerConfig: {}, steps: [] }).returning({ id: flows.id });
  const [m] = await db.insert(flowMemberships).values({ tenantId, contactId: c!.id, flowId: f!.id, enteredAt: new Date() }).returning({ id: flowMemberships.id });
  const [msg] = await db.insert(lifecycleMessages).values({ tenantId, contactId: c!.id, flowId: f!.id, membershipId: m!.id, flowStepOrder: 2, status: "pending_approval", subject: "Hello", brainActionType: "welcome" }).returning({ id: lifecycleMessages.id });
  messageId = msg!.id;
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM webhook_outbox WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM webhook_endpoints WHERE tenant_id = ${tenantId}`);
});

afterAll(async () => {
  for (const table of ["webhook_outbox", "webhook_endpoints", "lifecycle_messages", "flow_memberships", "flows", "contacts"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  await pool.end();
});

async function endpoint(values: Partial<typeof webhookEndpoints.$inferInsert>): Promise<string> {
  const [e] = await db
    .insert(webhookEndpoints)
    .values({ tenantId, slug: `ep-${randomUUID().slice(0, 6)}`, url: "http://127.0.0.1:9/claros", events: ["message.sent"], ...values })
    .returning({ id: webhookEndpoints.id });
  return e!.id;
}

async function outbox(endpointId: string, event: string, payload: Record<string, unknown>, extra: Partial<typeof webhookOutbox.$inferInsert> = {}): Promise<string> {
  const [o] = await db
    .insert(webhookOutbox)
    .values({ tenantId, endpointId, event, payload, nextAttemptAt: new Date(Date.now() - 1000), createdAt: new Date("2026-11-20T10:00:00Z"), ...extra })
    .returning({ id: webhookOutbox.id });
  return o!.id;
}

const row = async (id: string) => (await db.select().from(webhookOutbox).where(eq(webhookOutbox.id, id)))[0]!;
const encrypted = (s: string) => encrypt(s, parseEncryptionKey(KEY));

describe("webhook delivery", () => {
  it("signs with Standard Webhooks headers and sends the documented body", async () => {
    const ep = await endpoint({ secret: encrypted(SECRET), events: ["message.sent"] });
    const id = await outbox(ep, "message.sent", { message_id: messageId });
    const calls: Call[] = [];
    await processWebhookTick(db as never, new Date(), { fetch: fakeFetch(200, calls), encryptionKey: KEY, limit: 1000 });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9/claros");
    expect(calls[0]!.headers["webhook-id"]).toBe(id);
    expect(verifyWebhook({ headers: calls[0]!.headers, body: calls[0]!.body, secret: SECRET })).toBe(true);
    expect(verifyWebhook({ headers: calls[0]!.headers, body: calls[0]!.body + " ", secret: SECRET })).toBe(false);
    expect(JSON.parse(calls[0]!.body)).toEqual({
      type: "message.sent",
      timestamp: "2026-11-20T10:00:00.000Z",
      data: {
        product: slug,
        contact: { external_id: contactExt, email: "w@example.com" },
        message: { id: messageId, subject: "Hello", action_type: "welcome", step: 2, topic: null },
        flow: { id: expect.any(String), slug: "welcome", name: "Welcome" },
      },
    });
    expect((await row(id)).status).toBe("delivered");
  });

  it("adds the waiting count to message.pending_approval", async () => {
    const ep = await endpoint({ events: ["message.pending_approval"] });
    await outbox(ep, "message.pending_approval", { message_id: messageId });
    const calls: Call[] = [];
    await processWebhookTick(db as never, new Date(), { fetch: fakeFetch(204, calls), encryptionKey: KEY, limit: 1000 });
    expect(JSON.parse(calls[0]!.body).data.pending_count).toBe(1);
  });

  it("retries with backoff, then marks dead; a removed endpoint is dead at once", async () => {
    const ep = await endpoint({});
    const id = await outbox(ep, "message.sent", { message_id: messageId });
    const before = Date.now();
    await processWebhookTick(db as never, new Date(), { fetch: fakeFetch(500, []), encryptionKey: KEY, limit: 1000 });
    const r = await row(id);
    expect(r).toMatchObject({ status: "pending", attempts: 1, lastError: "HTTP 500: nope" });
    expect(r.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 59_000);
    await db.update(webhookOutbox).set({ attempts: WEBHOOK_MAX_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(webhookOutbox.id, id));
    await processWebhookTick(db as never, new Date(), { fetch: fakeFetch(500, []), encryptionKey: KEY, limit: 1000 });
    expect((await row(id)).status).toBe("dead");

    const gone = await outbox(randomUUID(), "message.sent", { message_id: messageId });
    await processWebhookTick(db as never, new Date(), { fetch: fakeFetch(200, []), encryptionKey: KEY, limit: 1000 });
    expect((await row(gone)).status).toBe("dead");
    expect((await row(gone)).lastError).toBe("endpoint removed or disabled");
  });
});

describe("analytics sink", () => {
  it("statsraven: POST /ingest?source=claros with the token and a flat event keyed to the external id", async () => {
    const ep = await endpoint({ kind: "analytics", slug: "analytics", url: "https://stats.example.test", secret: encrypted("sr-token"), config: { sink: "statsraven" }, events: ["message.sent", "flow.exited", "message.approved"] });
    await outbox(ep, "message.sent", { message_id: messageId });
    await outbox(ep, "message.approved", { message_id: messageId, decision: "approved" });
    const calls: Call[] = [];
    await processWebhookTick(db as never, new Date(), { fetch: fakeFetch(202, calls), encryptionKey: KEY, limit: 1000 });
    expect(calls.map((c) => c.url)).toEqual(["https://stats.example.test/ingest?source=claros", "https://stats.example.test/ingest?source=claros"]);
    expect(calls[0]!.headers.authorization).toBe("Bearer sr-token");
    const bodies = calls.map((c) => JSON.parse(c.body));
    expect(bodies).toContainEqual({
      event: "email_sent", ts: "2026-11-20T10:00:00.000Z", user_id: contactExt, product: slug,
      traits: { email: "w@example.com", name: "Wanda", plan: "pro" },
      message_id: messageId, action_type: "welcome", step: 2, flow: "welcome",
    });
    expect(bodies.find((b) => b.event === "approval_decided")).toMatchObject({ decision: "approved", user_id: contactExt });
    expect(statsravenIngestUrl("https://s.example/ingest")).toBe("https://s.example/ingest?source=claros");
    expect(statsravenIngestUrl("https://s.example/custom?source=x")).toBe("https://s.example/custom?source=x");
  });

  it("webhook sink: the flat event signed like a webhook", async () => {
    const ep = await endpoint({ kind: "analytics", slug: "analytics", url: "https://sink.example.test/in", secret: encrypted(SECRET), config: { sink: "webhook" }, events: ["flow.exited"] });
    await outbox(ep, "flow.exited", { membership_id: randomUUID(), contact_id: null, reason: "condition_met" });
    const calls: Call[] = [];
    await processWebhookTick(db as never, new Date(), { fetch: fakeFetch(200, calls), encryptionKey: KEY, limit: 1000 });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ event: "flow_exited", reason: "condition_met", product: slug });
    expect(JSON.parse(calls[0]!.body).traits).toBeUndefined(); // no contact, no traits
    expect(verifyWebhook({ headers: calls[0]!.headers, body: calls[0]!.body, secret: SECRET })).toBe(true);
  });
});
