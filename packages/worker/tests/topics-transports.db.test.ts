/**
 * Topics (G8a), transport routing and the Cloudflare policy (G26, D16) and
 * List-Unsubscribe per topic kind (D18) through the real drain and the real
 * database transport resolver. Provider HTTP APIs are fakes: global fetch is
 * stubbed and answers as Resend and the Cloudflare Email Service REST API do.
 *
 * Covered:
 *   - routing: a transactional-topic message goes through the transactional
 *     transport, everything else through the default transport
 *   - D18: transactional-topic messages carry no List-Unsubscribe headers but
 *     keep the postal footer; other messages carry them, and their token
 *     names the topic
 *   - Resend payload: reply_to and tags (claros_tenant, claros_message_id, claros_flow)
 *   - transport_policy: a non-transactional message routed to a cloudflare
 *     transport is failed, nothing is sent
 *   - topic gate: a topic unsubscribe blocks that topic's mail but not a
 *     transactional-topic message; default_subscribed = false without a row
 *     blocks; a product-wide suppression blocks everything
 *   - daily_limit per transport
 *   - targeted drain (drain-message) routes the same way
 *
 * Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  tenants,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
  suppressions,
  topics,
  contactTopics,
  transportConfigs,
} from "@claros/db/schema";
import { encrypt, parseEncryptionKey, verifyUnsubscribeToken } from "@claros/adapters";
import { processDrainTick, fetchDrainBatchSimple, type FetchDrainBatch } from "../src/drain.js";
import { handleDrainMessage } from "../src/drain-message.js";
import { buildTenantTransportResolver } from "../src/transport-resolver.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[topics-transports.test] DATABASE_URL is not set.");

const SIGNING_KEY = "topics-transports-test-signing-key-do-not-use";
const ENCRYPTION_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="; // 32 bytes of 0x01, tests only
const POSTAL = "1 Topic St, Test City";
const SLUG = `test-topics-transports-${randomUUID().slice(0, 8)}`;
const NOW = new Date("2026-11-20T12:00:00Z");

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let tenantId: string;
let contactId: string;
let flowId: string;
let marketingTopic: string;
let transactionalTopic: string;
let optInTopic: string;
let resendId: string;
let cloudflareId: string;
let previousKey: string | undefined;

interface Call {
  url: string;
  body: Record<string, any>;
}
let calls: Call[] = [];

function fakeFetch() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body });
    if (url.startsWith("https://api.resend.com/")) {
      return new Response(JSON.stringify({ id: `re-${calls.length}` }), { status: 200 });
    }
    if (url.startsWith("https://api.cloudflare.com/")) {
      return new Response(
        JSON.stringify({ success: true, errors: [], messages: [], result: { message_id: `<cf-${calls.length}@x>` } }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });
}

function envelope(creds: Record<string, unknown>): string {
  return encrypt(JSON.stringify(creds), parseEncryptionKey(ENCRYPTION_KEY));
}

/** No frequency caps and an always-open send window: these tests are about topics and transports. */
const OPEN_THROTTLE = {
  max_emails_per_user_per_day: 100,
  max_emails_per_user_per_week: 500,
  min_interval_between_emails_hours: 0,
  send_window_start: "00:00",
  send_window_end: "23:59",
  send_window_days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  send_window_timezone: "tenant_fixed",
  tenant_timezone: "UTC",
};

async function setRouting(routing: Record<string, string> | null) {
  await db
    .update(tenants)
    .set({
      settings: { postal_address: POSTAL, throttle: OPEN_THROTTLE, ...(routing ? { transport_routing: routing } : {}) },
    })
    .where(eq(tenants.id, tenantId));
}

let step = 0;
async function message(topicId: string | null): Promise<string> {
  const membershipId = randomUUID();
  await db.insert(flowMemberships).values({
    id: membershipId,
    tenantId,
    contactId,
    flowId,
    currentStep: 1,
    status: "completed",
    enteredAt: new Date("2026-01-01T00:00:00Z"),
  });
  const id = randomUUID();
  await db.insert(lifecycleMessages).values({
    id,
    tenantId,
    contactId,
    flowId,
    membershipId,
    flowStepOrder: ++step,
    status: "approved",
    subject: "Hello",
    bodyHtml: "<p>Body</p>",
    bodyText: "Body",
    topicId,
  });
  return id;
}

async function row(id: string) {
  const [r] = await db.select().from(lifecycleMessages).where(eq(lifecycleMessages.id, id));
  return r!;
}

/** One drain tick scoped to this file's tenant, with the real database resolver. */
async function drain(now = NOW) {
  const resolver = buildTenantTransportResolver(db as never);
  const scoped: FetchDrainBatch = (d, n, limit, ids) => fetchDrainBatchSimple(d, n, limit, ids.filter((x) => x === tenantId));
  return processDrainTick(
    db as never,
    now,
    (tid, route) => (tid === tenantId ? resolver(tid, route) : Promise.resolve(null)),
    scoped,
    50,
    "http://localhost:3000",
    SIGNING_KEY,
    false,
  );
}

beforeAll(async () => {
  previousKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  pool = new pg.Pool({ connectionString: TEST_DB_URL });
  db = drizzle(pool);

  const [t] = await db
    .insert(tenants)
    .values({ name: "Topics Transports", slug: SLUG, settings: { postal_address: POSTAL } })
    .returning({ id: tenants.id });
  tenantId = t!.id;
  const [c] = await db
    .insert(contacts)
    .values({ tenantId, externalId: "u1", email: "ann@example.com", lifecycleState: "signed_up" })
    .returning({ id: contacts.id });
  contactId = c!.id;
  const [f] = await db
    .insert(flows)
    .values({ tenantId, name: "F", triggerType: "manual", triggerConfig: {}, steps: [], status: "active" })
    .returning({ id: flows.id });
  flowId = f!.id;

  const [m, x, o] = await db
    .insert(topics)
    .values([
      { tenantId, slug: "news", name: "News", kind: "marketing" },
      { tenantId, slug: "receipts", name: "Receipts", kind: "transactional" },
      { tenantId, slug: "beta", name: "Beta", kind: "lifecycle", defaultSubscribed: false },
    ])
    .returning({ id: topics.id });
  marketingTopic = m!.id;
  transactionalTopic = x!.id;
  optInTopic = o!.id;

  const [r] = await db
    .insert(transportConfigs)
    .values({
      tenantId,
      provider: "resend",
      kind: "resend",
      config: sql`${envelope({ apiKey: "re_fake_key" })}::jsonb`,
      fromEmail: "hello@example.com",
      fromName: "Example",
      replyTo: "support@example.com",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: transportConfigs.id });
  resendId = r!.id;
  const [cf] = await db
    .insert(transportConfigs)
    .values({
      tenantId,
      provider: "cloudflare",
      kind: "cloudflare",
      config: sql`${envelope({ accountId: "acc123", apiToken: "cf_fake_token" })}::jsonb`,
      fromEmail: "receipts@example.com",
      fromName: null,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    })
    .returning({ id: transportConfigs.id });
  cloudflareId = cf!.id;
});

beforeEach(async () => {
  calls = [];
  vi.stubGlobal("fetch", fakeFetch());
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM contact_topics WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM suppressions WHERE tenant_id = ${tenantId}`);
  await db.update(transportConfigs).set({ dailyLimit: null }).where(eq(transportConfigs.tenantId, tenantId));
  await setRouting({ transactional: cloudflareId });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const table of ["lifecycle_messages", "flow_memberships", "contact_topics", "suppressions", "transport_configs"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`UPDATE flows SET topic_id = NULL WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM topics WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  await pool.end();
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousKey;
});

const resendCalls = () => calls.filter((c) => c.url === "https://api.resend.com/emails");
const cloudflareCalls = () => calls.filter((c) => c.url.startsWith("https://api.cloudflare.com/"));

describe("routing and List-Unsubscribe per topic kind", () => {
  it("sends transactional-topic mail through the transactional transport without List-Unsubscribe, the rest through the default", async () => {
    const tx = await message(transactionalTopic);
    const mk = await message(marketingTopic);
    const plain = await message(null);

    const result = await drain();
    expect(result.sent).toBe(3);

    // Transactional: Cloudflare REST, no List-Unsubscribe, postal footer kept.
    expect(cloudflareCalls()).toHaveLength(1);
    const cf = cloudflareCalls()[0]!;
    expect(cf.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send");
    expect(cf.body.from).toBe("receipts@example.com");
    expect(cf.body.to).toBe("ann@example.com");
    expect(cf.body.headers ?? {}).not.toHaveProperty("List-Unsubscribe");
    expect(cf.body.headers ?? {}).not.toHaveProperty("List-Unsubscribe-Post");
    expect(cf.body.html).toContain(POSTAL);
    expect(await row(tx)).toMatchObject({ status: "sent", transportId: cloudflareId });

    // Marketing and no-topic: Resend with headers, reply_to and tags.
    const resend = resendCalls();
    expect(resend).toHaveLength(2);
    for (const call of resend) {
      expect(call.body.headers["List-Unsubscribe"]).toMatch(/^<http:\/\/localhost:3000\/unsubscribe\/one-click\?token=/);
      expect(call.body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(call.body.reply_to).toBe("support@example.com");
      expect(call.body.from).toBe("Example <hello@example.com>");
    }
    const byMessage = (id: string) =>
      resend.find((c) => c.body.tags.some((t: { name: string; value: string }) => t.name === "claros_message_id" && t.value === id))!;
    expect(byMessage(mk).body.tags).toEqual([
      { name: "claros_tenant", value: tenantId },
      { name: "claros_message_id", value: mk },
      { name: "claros_flow", value: flowId },
    ]);

    // The marketing token names the topic; the topic-less token does not (as before).
    const tokenOf = (call: Call) => /token=([^>]+)>/.exec(call.body.headers["List-Unsubscribe"])![1]!;
    const mkToken = verifyUnsubscribeToken(tokenOf(byMessage(mk)), SIGNING_KEY);
    const plainToken = verifyUnsubscribeToken(tokenOf(byMessage(plain)), SIGNING_KEY);
    expect(mkToken.ok && mkToken.payload.topicId).toBe(marketingTopic);
    expect(plainToken.ok && plainToken.payload.topicId).toBeUndefined();
    expect(await row(mk)).toMatchObject({ status: "sent", transportId: resendId });
    expect(await row(plain)).toMatchObject({ status: "sent", transportId: resendId });
  });

  it("without transport routing everything goes through the default (oldest) transport", async () => {
    await setRouting(null);
    const tx = await message(transactionalTopic);
    await drain();
    expect(cloudflareCalls()).toHaveLength(0);
    expect(resendCalls()).toHaveLength(1);
    // Still transactional: no List-Unsubscribe headers (D18).
    expect(resendCalls()[0]!.body.headers).toEqual({});
    expect(await row(tx)).toMatchObject({ status: "sent", transportId: resendId });
  });

  it("the targeted drain (drain-message) routes the same way", async () => {
    // handleDrainMessage reads the signing key from the environment; pin it so
    // the test does not depend on the developer's .env.
    vi.stubEnv("UNSUBSCRIBE_SIGNING_KEY", SIGNING_KEY);
    const tx = await message(transactionalTopic);
    const resolver = buildTenantTransportResolver(db as never);
    const out = await handleDrainMessage({ tenant_id: tenantId, message_id: tx } as never, db as never, resolver);
    expect(out).toEqual({ claimed: true, outcome: "sent" });
    expect(cloudflareCalls()).toHaveLength(1);
    expect(await row(tx)).toMatchObject({ status: "sent", transportId: cloudflareId });
    vi.unstubAllEnvs();
  });
});

describe("transport policy (D16)", () => {
  it("fails a marketing or lifecycle message routed to a cloudflare transport with transport_policy, nothing sent", async () => {
    // Written directly: the routing API refuses a cloudflare default (400).
    await setRouting({ default: cloudflareId });
    const mk = await message(marketingTopic);
    const plain = await message(null);
    const tx = await message(transactionalTopic);

    const result = await drain();
    expect(result.transportPolicyFailures).toBe(2);
    expect(await row(mk)).toMatchObject({ status: "failed", statusReason: "transport_policy", recipientAddress: null });
    expect(await row(plain)).toMatchObject({ status: "failed", statusReason: "transport_policy" });
    // The transactional message is allowed through Cloudflare.
    expect(await row(tx)).toMatchObject({ status: "sent", transportId: cloudflareId });
    expect(cloudflareCalls()).toHaveLength(1);
    expect(resendCalls()).toHaveLength(0);
  });
});

describe("topic gate (G8a)", () => {
  it("a topic unsubscribe blocks that topic's mail but not a transactional-topic message", async () => {
    await db.insert(contactTopics).values([
      { tenantId, contactId, topicId: marketingTopic, status: "unsubscribed", source: "page" },
      // Ignored for transactional topics.
      { tenantId, contactId, topicId: transactionalTopic, status: "unsubscribed", source: "page" },
    ]);
    const mk = await message(marketingTopic);
    const tx = await message(transactionalTopic);
    const plain = await message(null);

    const result = await drain();
    expect(result.topicUnsubscribed).toBe(1);
    expect(await row(mk)).toMatchObject({ status: "suppressed", statusReason: "topic_unsubscribed" });
    expect(await row(tx)).toMatchObject({ status: "sent" });
    expect(await row(plain)).toMatchObject({ status: "sent" });
  });

  it("default_subscribed = false blocks until the contact subscribes", async () => {
    const first = await message(optInTopic);
    await drain();
    expect(await row(first)).toMatchObject({ status: "suppressed", statusReason: "topic_unsubscribed" });

    await db.insert(contactTopics).values({ tenantId, contactId, topicId: optInTopic, status: "subscribed", source: "identify" });
    const second = await message(optInTopic);
    await drain();
    expect(await row(second)).toMatchObject({ status: "sent" });
  });

  it("a product-wide unsubscribe (suppression) still blocks everything, transactional included", async () => {
    await db.insert(suppressions).values({ tenantId, email: "ann@example.com", reason: "unsubscribe", source: "page" });
    const mk = await message(marketingTopic);
    const tx = await message(transactionalTopic);
    const plain = await message(null);
    await drain();
    for (const id of [mk, tx, plain]) {
      expect(await row(id)).toMatchObject({ status: "suppressed", statusReason: null });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("daily_limit per transport", () => {
  it("a full default transport defers its mail while the transactional transport keeps sending", async () => {
    await db.update(transportConfigs).set({ dailyLimit: 1 }).where(eq(transportConfigs.id, resendId));
    const a = await message(marketingTopic);
    const b = await message(marketingTopic);
    const tx = await message(transactionalTopic);
    await drain();
    const statuses = [(await row(a)).status, (await row(b)).status].sort();
    expect(statuses).toEqual(["approved", "sent"]);
    expect(await row(tx)).toMatchObject({ status: "sent", transportId: cloudflareId });
  });
});
