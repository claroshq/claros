/**
 * HTTP tests for topics (G8a) and transports with routing (G26, D16, D18):
 *
 *   - /v1/topics: list, create (409 on duplicate slug), patch; owner for writes
 *   - /v1/settings/transports: add (resend, cloudflare), list, patch, delete;
 *     credentials never returned; owner for writes
 *   - PUT /v1/settings/transport-routing: a cloudflare default is refused (400),
 *     a cloudflare transactional route is accepted
 *   - v0.6 PUT/GET /v1/settings/transport act on the default transport and
 *     leave the other transports active
 *   - flows carry topic_id (validated against the product's topics)
 *   - identify traits.topics sets contact topic statuses; unknown slugs ignored
 *   - GET /v1/contacts/:id lists topic statuses
 *   - unsubscribe: an old token (no topic) suppresses the product; a topic
 *     token unsubscribes that topic only; the page lists topics and saves
 *     checkboxes (action=topics) or suppresses (action=all)
 *
 * No provider is called (cloudflare transports are stored with REST
 * credentials, nothing is sent). Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { buildApp, hashApiKey } from "../src/index.js";
import {
  tenants,
  users,
  sessions,
  apiKeys,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
  suppressions,
  topics,
  contactTopics,
  transportConfigs,
} from "@claros/db/schema";
import { generateUnsubscribeToken } from "@claros/adapters";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[topics-transports.test] DATABASE_URL is not set.");

const ENCRYPTION_KEY = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="; // 32 bytes of 0x02, tests only
const SIGNING_KEY = "api-topics-transports-signing-key-do-not-use";
const SLUG = `test-api-topics-${randomUUID().slice(0, 8)}`;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let tenantId: string;
let ownerCookie: string;
let memberCookie: string;
let rawApiKey: string;
const savedEnv: Record<string, string | undefined> = {};

async function app() {
  return buildApp({ db, logger: false, baseUrl: "http://localhost:3000" });
}

function json(cookie: string) {
  return { cookie, "content-type": "application/json" };
}

beforeAll(async () => {
  for (const k of ["ENCRYPTION_KEY", "UNSUBSCRIBE_SIGNING_KEY"]) savedEnv[k] = process.env[k];
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.UNSUBSCRIBE_SIGNING_KEY = SIGNING_KEY;

  pool = new pg.Pool({ connectionString: TEST_DB_URL });
  db = drizzle(pool);
  const [t] = await db.insert(tenants).values({ name: "API Topics", slug: SLUG }).returning({ id: tenants.id });
  tenantId = t!.id;
  const [owner] = await db
    .insert(users)
    .values({ tenantId, email: `owner-${SLUG}@example.com`, role: "owner" })
    .returning({ id: users.id });
  const [member] = await db
    .insert(users)
    .values({ tenantId, email: `member-${SLUG}@example.com`, role: "member" })
    .returning({ id: users.id });
  const expiresAt = new Date(Date.now() + 86_400_000);
  const [so] = await db.insert(sessions).values({ tenantId, userId: owner!.id, expiresAt }).returning({ id: sessions.id });
  const [sm] = await db.insert(sessions).values({ tenantId, userId: member!.id, expiresAt }).returning({ id: sessions.id });
  ownerCookie = `claros_session=${so!.id}`;
  memberCookie = `claros_session=${sm!.id}`;
  rawApiKey = `cl_live_${randomBytes(32).toString("base64url")}`;
  await db.insert(apiKeys).values({ tenantId, keyHash: hashApiKey(rawApiKey), prefix: rawApiKey.slice(0, 8), label: "t" });
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${tenantId}`);
  await db.update(tenants).set({ settings: null }).where(eq(tenants.id, tenantId));
});

afterAll(async () => {
  for (const table of [
    "contact_topics", "lifecycle_messages", "flow_memberships", "suppressions", "transport_configs",
    "events", "contact_conflicts", "lifecycle_transitions",
  ]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM topics WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM sessions WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM memberships WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM users WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  await pool.end();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

describe("/v1/topics", () => {
  it("creates, lists and patches topics; owner role for writes; duplicate slug 409", async () => {
    const a = await app();
    const create = await a.inject({
      method: "POST", url: "/v1/topics", headers: json(ownerCookie),
      payload: { slug: "api-news", name: "News", kind: "marketing", description: "Monthly" },
    });
    expect(create.statusCode).toBe(201);
    const topic = create.json().topic;
    expect(topic).toMatchObject({ slug: "api-news", name: "News", kind: "marketing", default_subscribed: true, description: "Monthly" });

    expect((await a.inject({ method: "POST", url: "/v1/topics", headers: json(ownerCookie), payload: { slug: "api-news", name: "Again", kind: "marketing" } })).statusCode).toBe(409);
    expect((await a.inject({ method: "POST", url: "/v1/topics", headers: json(ownerCookie), payload: { slug: "Bad Slug", name: "X", kind: "marketing" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/v1/topics", headers: json(ownerCookie), payload: { slug: "x", name: "X", kind: "promo" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/v1/topics", headers: json(memberCookie), payload: { slug: "m", name: "M", kind: "marketing" } })).statusCode).toBe(403);

    const list = await a.inject({ method: "GET", url: "/v1/topics", headers: { cookie: memberCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().topics.map((t: { slug: string }) => t.slug)).toContain("api-news");

    const patch = await a.inject({
      method: "PATCH", url: `/v1/topics/${topic.id}`, headers: json(ownerCookie),
      payload: { kind: "lifecycle", default_subscribed: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().topic).toMatchObject({ slug: "api-news", kind: "lifecycle", default_subscribed: false });
    expect((await a.inject({ method: "PATCH", url: `/v1/topics/${topic.id}`, headers: json(ownerCookie), payload: { slug: "other" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "PATCH", url: `/v1/topics/${randomUUID()}`, headers: json(ownerCookie), payload: { name: "x" } })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Transports and routing
// ---------------------------------------------------------------------------

describe("/v1/settings/transports and routing", () => {
  async function addResend(a: Awaited<ReturnType<typeof app>>, from = "hello@example.com") {
    const res = await a.inject({
      method: "POST", url: "/v1/settings/transports", headers: json(ownerCookie),
      payload: { kind: "resend", name: "Main", from_email: from, reply_to: "help@example.com", api_key: "re_secret_api_key" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().transport;
  }
  async function addCloudflare(a: Awaited<ReturnType<typeof app>>) {
    const res = await a.inject({
      method: "POST", url: "/v1/settings/transports", headers: json(ownerCookie),
      payload: { kind: "cloudflare", from_email: "receipts@example.com", account_id: "acc", api_token: "cf_secret_token" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().transport;
  }

  it("adds several transports, never returns credentials, and lists them with routing", async () => {
    const a = await app();
    const resend = await addResend(a);
    const cf = await addCloudflare(a);
    expect(resend).toMatchObject({ kind: "resend", name: "Main", reply_to: "help@example.com", is_active: true });
    expect(cf).toMatchObject({ kind: "cloudflare", from_email: "receipts@example.com" });

    const list = await a.inject({ method: "GET", url: "/v1/settings/transports", headers: { cookie: memberCookie } });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.transports.map((t: { id: string }) => t.id)).toEqual([resend.id, cf.id]);
    expect(body.routing).toEqual({ transactional: null, default: null });
    expect(body.effective).toEqual({ default: resend.id, transactional: resend.id });
    expect(JSON.stringify(body)).not.toContain("re_secret_api_key");
    expect(JSON.stringify(body)).not.toContain("cf_secret_token");

    expect((await a.inject({ method: "POST", url: "/v1/settings/transports", headers: json(memberCookie), payload: { kind: "resend", from_email: "a@example.com", api_key: "x" } })).statusCode).toBe(403);
    expect((await a.inject({ method: "POST", url: "/v1/settings/transports", headers: json(ownerCookie), payload: { kind: "cloudflare", from_email: "a@example.com" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/v1/settings/transports", headers: json(ownerCookie), payload: { kind: "ses", from_email: "a@example.com" } })).statusCode).toBe(400);
  });

  it("refuses a cloudflare default route (400) and accepts it as the transactional route", async () => {
    const a = await app();
    const resend = await addResend(a);
    const cf = await addCloudflare(a);

    const refused = await a.inject({ method: "PUT", url: "/v1/settings/transport-routing", headers: json(ownerCookie), payload: { default: cf.id } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/transactional mail only/);

    const ok = await a.inject({
      method: "PUT", url: "/v1/settings/transport-routing", headers: json(ownerCookie),
      payload: { transactional: cf.id, default: resend.id },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      routing: { transactional: cf.id, default: resend.id },
      effective: { transactional: cf.id, default: resend.id },
      warnings: [],
    });
    const [t] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
    expect((t!.settings as Record<string, unknown>).transport_routing).toEqual({ transactional: cf.id, default: resend.id });

    expect((await a.inject({ method: "PUT", url: "/v1/settings/transport-routing", headers: json(ownerCookie), payload: { transactional: randomUUID() } })).statusCode).toBe(400);
    expect((await a.inject({ method: "PUT", url: "/v1/settings/transport-routing", headers: json(memberCookie), payload: { transactional: null } })).statusCode).toBe(403);

    // Deleting a routed transport clears it from routing.
    const del = await a.inject({ method: "DELETE", url: `/v1/settings/transports/${cf.id}`, headers: { cookie: ownerCookie } });
    expect(del.statusCode).toBe(200);
    const after = (await a.inject({ method: "GET", url: "/v1/settings/transports", headers: { cookie: ownerCookie } })).json();
    expect(after.transports.map((x: { id: string }) => x.id)).toEqual([resend.id]);
    expect(after.routing).toEqual({ transactional: null, default: resend.id });
  });

  it("patches a transport (fields and credentials) and 404s for unknown ids", async () => {
    const a = await app();
    const resend = await addResend(a);
    const res = await a.inject({
      method: "PATCH", url: `/v1/settings/transports/${resend.id}`, headers: json(ownerCookie),
      payload: { name: null, reply_to: null, daily_limit: 500, api_key: "re_rotated_key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transport).toMatchObject({ id: resend.id, name: null, reply_to: null, daily_limit: 500 });
    expect(JSON.stringify(res.json())).not.toContain("re_rotated_key");
    expect((await a.inject({ method: "PATCH", url: `/v1/settings/transports/${randomUUID()}`, headers: json(ownerCookie), payload: { name: "x" } })).statusCode).toBe(404);
  });

  it("v0.6 PUT/GET /v1/settings/transport replace and read the default transport only", async () => {
    const a = await app();
    const first = await addResend(a, "first@example.com");
    const cf = await addCloudflare(a);
    await a.inject({ method: "PUT", url: "/v1/settings/transport-routing", headers: json(ownerCookie), payload: { transactional: cf.id } });

    const put = await a.inject({
      method: "PUT", url: "/v1/settings/transport", headers: json(ownerCookie),
      payload: { provider: "resend", from_email: "second@example.com", api_key: "re_second" },
    });
    expect(put.statusCode).toBe(200);
    const replacement = put.json().transport;

    const active = await db
      .select({ id: transportConfigs.id })
      .from(transportConfigs)
      .where(and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)));
    expect(active.map((r) => r.id).sort()).toEqual([cf.id, replacement.id].sort());
    expect(active.map((r) => r.id)).not.toContain(first.id);

    const get = await a.inject({ method: "GET", url: "/v1/settings/transport", headers: { cookie: ownerCookie } });
    expect(get.json().transport).toMatchObject({ id: replacement.id, from_email: "second@example.com", provider: "resend" });
    const routed = (await a.inject({ method: "GET", url: "/v1/settings/transports", headers: { cookie: ownerCookie } })).json();
    expect(routed.routing).toEqual({ transactional: cf.id, default: replacement.id });
  });
});

// ---------------------------------------------------------------------------
// Flows, identify, contacts
// ---------------------------------------------------------------------------

describe("flows, identify traits and contact topic statuses", () => {
  it("flows accept a topic of the product and reject others", async () => {
    const a = await app();
    const [topic] = await db.insert(topics).values({ tenantId, slug: `flow-${randomUUID().slice(0, 6)}`, name: "T", kind: "lifecycle" }).returning({ id: topics.id });
    const base = { name: "Flow", trigger_type: "manual", trigger_config: {}, steps: [] };
    const created = await a.inject({ method: "POST", url: "/v1/flows", headers: json(ownerCookie), payload: { ...base, topic_id: topic!.id } });
    expect(created.statusCode).toBe(201);
    expect(created.json().topic_id).toBe(topic!.id);
    expect((await a.inject({ method: "POST", url: "/v1/flows", headers: json(ownerCookie), payload: { ...base, topic_id: randomUUID() } })).statusCode).toBe(400);
    const patched = await a.inject({ method: "PATCH", url: `/v1/flows/${created.json().id}`, headers: json(ownerCookie), payload: { topic_id: null } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().topic_id).toBeNull();
  });

  it("identify traits.topics sets statuses (unknown slugs ignored) and GET /v1/contacts/:id lists them", async () => {
    const a = await app();
    const suffix = randomUUID().slice(0, 6);
    await db.insert(topics).values([
      { tenantId, slug: `news-${suffix}`, name: "News", kind: "marketing" },
      { tenantId, slug: `beta-${suffix}`, name: "Beta", kind: "lifecycle", defaultSubscribed: false },
    ]);
    const userId = `user-${suffix}`;
    const res = await a.inject({
      method: "POST", url: "/v1/identify", headers: { authorization: `Bearer ${rawApiKey}` },
      payload: { userId, traits: { email: `${suffix}@example.com`, topics: { [`news-${suffix}`]: false, unknown: true, [`beta-${suffix}`]: "yes" } } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const [contact] = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.externalId, userId)));
    const detail = await a.inject({ method: "GET", url: `/v1/contacts/${contact!.id}`, headers: { cookie: memberCookie } });
    expect(detail.statusCode).toBe(200);
    const statuses = Object.fromEntries(
      (detail.json().topics as Array<{ slug: string; status: string; default: boolean; source: string | null }>)
        .filter((t) => t.slug.endsWith(suffix))
        .map((t) => [t.slug, [t.status, t.default, t.source]]),
    );
    expect(statuses).toEqual({
      [`news-${suffix}`]: ["unsubscribed", false, "identify"],
      // Non-boolean value ignored: the topic default applies.
      [`beta-${suffix}`]: ["unsubscribed", true, null],
    });
  });
});

// ---------------------------------------------------------------------------
// Unsubscribe
// ---------------------------------------------------------------------------

describe("unsubscribe with topics", () => {
  let contactId: string;
  let email: string;
  let news: string;
  let tips: string;
  let receipts: string;

  async function sentMessage(topicId: string | null): Promise<string> {
    const [flow] = await db.insert(flows).values({ tenantId, name: "F", triggerType: "manual", triggerConfig: {}, steps: [] }).returning({ id: flows.id });
    const [m] = await db
      .insert(flowMemberships)
      .values({ tenantId, contactId, flowId: flow!.id, status: "completed", enteredAt: new Date() })
      .returning({ id: flowMemberships.id });
    const [msg] = await db
      .insert(lifecycleMessages)
      .values({ tenantId, contactId, flowId: flow!.id, membershipId: m!.id, flowStepOrder: 1, status: "sent", recipientAddress: email, topicId })
      .returning({ id: lifecycleMessages.id });
    return msg!.id;
  }

  async function statusOf(topicId: string): Promise<string | null> {
    const rows = await db.select({ status: contactTopics.status }).from(contactTopics)
      .where(and(eq(contactTopics.contactId, contactId), eq(contactTopics.topicId, topicId)));
    return rows[0]?.status ?? null;
  }

  async function suppressed(): Promise<boolean> {
    const rows = await db.select({ id: suppressions.id }).from(suppressions)
      .where(and(eq(suppressions.tenantId, tenantId), sql`lower(${suppressions.email}) = ${email}`));
    return rows.length > 0;
  }

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    email = `unsub-${suffix}@example.com`;
    const [c] = await db.insert(contacts).values({ tenantId, externalId: `u-${suffix}`, email, lifecycleState: "signed_up" }).returning({ id: contacts.id });
    contactId = c!.id;
    const rows = await db.insert(topics).values([
      { tenantId, slug: `n-${suffix}`, name: "News <weekly>", kind: "marketing" },
      { tenantId, slug: `t-${suffix}`, name: "Tips", kind: "lifecycle" },
      { tenantId, slug: `r-${suffix}`, name: "Receipts", kind: "transactional" },
    ]).returning({ id: topics.id });
    [news, tips, receipts] = rows.map((r) => r.id) as [string, string, string];
  });

  it("an old token (no topic) still suppresses the whole product via one-click", async () => {
    const a = await app();
    const msg = await sentMessage(null);
    const token = generateUnsubscribeToken(tenantId, msg, SIGNING_KEY);
    const res = await a.inject({
      method: "POST", url: `/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unsubscribed: true });
    expect(await suppressed()).toBe(true);
  });

  it("a topic token unsubscribes that topic only (one-click and the v0.6 form POST)", async () => {
    const a = await app();
    const msg = await sentMessage(news);
    const token = generateUnsubscribeToken(tenantId, msg, SIGNING_KEY, { topicId: news });
    const res = await a.inject({
      method: "POST", url: `/unsubscribe/one-click?token=${encodeURIComponent(token)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click",
    });
    expect(res.statusCode).toBe(200);
    expect(await statusOf(news)).toBe("unsubscribed");
    expect(await statusOf(tips)).toBeNull();
    expect(await suppressed()).toBe(false);

    const msg2 = await sentMessage(tips);
    const token2 = generateUnsubscribeToken(tenantId, msg2, SIGNING_KEY, { topicId: tips });
    const form = await a.inject({
      method: "POST", url: "/unsubscribe", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token2)}`,
    });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain("this type of email");
    expect(await statusOf(tips)).toBe("unsubscribed");
    expect(await suppressed()).toBe(false);
  });

  it("the page lists non-transactional topics with checkboxes and never writes on GET", async () => {
    const a = await app();
    const msg = await sentMessage(news);
    const token = generateUnsubscribeToken(tenantId, msg, SIGNING_KEY, { topicId: news });
    const page = await a.inject({ method: "GET", url: `/unsubscribe?token=${encodeURIComponent(token)}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`name="topic_${news}"`);
    expect(page.body).toContain(`name="topic_${tips}"`);
    expect(page.body).not.toContain(`name="topic_${receipts}"`);
    expect(page.body).toContain("News &lt;weekly&gt;");
    expect(page.body).toContain('value="all"');
    expect(await statusOf(news)).toBeNull();
    expect(await suppressed()).toBe(false);
  });

  it("action=topics saves the checkboxes; action=all suppresses the product", async () => {
    const a = await app();
    const msg = await sentMessage(news);
    const token = generateUnsubscribeToken(tenantId, msg, SIGNING_KEY, { topicId: news });
    const save = await a.inject({
      method: "POST", url: "/unsubscribe", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token)}&topic_${tips}=1&action=topics`,
    });
    expect(save.statusCode).toBe(200);
    expect(save.body).toContain("Preferences saved");
    expect(await statusOf(news)).toBe("unsubscribed");
    expect(await statusOf(tips)).toBe("subscribed");
    expect(await statusOf(receipts)).toBeNull();
    expect(await suppressed()).toBe(false);

    const all = await a.inject({
      method: "POST", url: "/unsubscribe", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token)}&action=all`,
    });
    expect(all.statusCode).toBe(200);
    expect(await suppressed()).toBe(true);
  });
});
