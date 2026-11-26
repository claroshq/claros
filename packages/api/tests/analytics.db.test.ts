/**
 * Analytics integration tests.
 *
 * Coverage:
 *
 * Lifecycle endpoint (GET /v1/analytics/lifecycle):
 *   - distribution counts contacts per state with the engagement depth matrix
 *   - contacts_total equals the sum of distribution rows
 *   - empty tenant returns zeroed distribution and movement, not an error
 *   - movement per_state counts entries and exits per state within range
 *   - movement edges aggregate (from_state, to_state) with counts, capped at 20
 *   - movement days series is per-day counts, ascending
 *   - transitions older than the range are excluded
 *   - ?days=7 vs ?days=30 boundary: a transition 10 days old is in one, not the other
 *   - ?days=0 and ?days=91 return 400 with issues
 *   - 401 without a session cookie
 *   - tenant isolation: a second tenant sees only its own distribution and movement
 *
 * Sending endpoint (GET /v1/analytics/sending):
 *   - totals count sent (sent_at IS NOT NULL), opened (opened or clicked),
 *     clicked, bounced, complained, suppressed, failed correctly
 *   - days series counts sends per day within range
 *   - messages older than the range are excluded (created_at boundary)
 *   - per_flow groups by flow with the flow name, ordered by sent desc
 *   - empty tenant returns zeroed totals and empty arrays
 *   - ?days=0 and ?days=91 return 400 with issues
 *   - 401 without a session cookie
 *   - tenant isolation: a second tenant sees only its own messages
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import {
  tenants,
  users,
  sessions,
  contacts,
  flows,
  flowMemberships,
  lifecycleTransitions,
  lifecycleMessages,
  retentionGridSnapshots,
} from "@claros/db/schema";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error(
    `[analytics.test] DATABASE_URL is not set. Set it in .env or export it.`,
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantAId: string;
let cookieA: string;
let tenantBId: string;
let cookieB: string;
let flowAId: string;
let flowA2Id: string;

const TEST_SLUG_A = "test-analytics-a";
const TEST_SLUG_B = "test-analytics-b";

const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * 86400_000);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") {
      throw new Error(`[analytics.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    }
    console.warn("[analytics.test] DATABASE_URL not reachable - integration tests will be skipped.");
    return;
  }

  for (const slug of [TEST_SLUG_A, TEST_SLUG_B]) {
    await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM lifecycle_transitions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM retention_grid_snapshots WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }

  async function makeTenant(slug: string, email: string) {
    const [t] = await db
      .insert(tenants)
      .values({ name: slug, slug, plan: "free" })
      .returning({ id: tenants.id });
    const [u] = await db
      .insert(users)
      .values({ tenantId: t!.id, email, role: "owner" })
      .returning({ id: users.id });
    const [s] = await db
      .insert(sessions)
      .values({ tenantId: t!.id, userId: u!.id, expiresAt: new Date(now + 86400_000) })
      .returning({ id: sessions.id });
    return { tenantId: t!.id, cookie: `claros_session=${s!.id}` };
  }

  const a = await makeTenant(TEST_SLUG_A, "owner-a@analytics.test");
  tenantAId = a.tenantId;
  cookieA = a.cookie;
  const b = await makeTenant(TEST_SLUG_B, "owner-b@analytics.test");
  tenantBId = b.tenantId;
  cookieB = b.cookie;

  // Contacts in tenant A: 5 across states and depths
  await db.insert(contacts).values([
    { tenantId: tenantAId, externalId: "a1", email: "a1@x.dev", lifecycleState: "engaged", engagementDepth: "power" },
    { tenantId: tenantAId, externalId: "a2", email: "a2@x.dev", lifecycleState: "engaged", engagementDepth: "regular" },
    { tenantId: tenantAId, externalId: "a3", email: "a3@x.dev", lifecycleState: "at_risk", engagementDepth: "casual" },
    { tenantId: tenantAId, externalId: "a4", email: "a4@x.dev", lifecycleState: "churned", engagementDepth: null },
    { tenantId: tenantAId, externalId: "a5", email: "a5@x.dev", lifecycleState: "signed_up", engagementDepth: "minimal" },
  ]);

  // One contact in tenant B
  await db.insert(contacts).values({
    tenantId: tenantBId,
    externalId: "b1",
    email: "b1@x.dev",
    lifecycleState: "engaged",
    engagementDepth: "power",
  });

  // Flows in tenant A
  const [f1] = await db
    .insert(flows)
    .values({ tenantId: tenantAId, name: "Flow One", triggerType: "event", triggerConfig: {}, steps: [] })
    .returning({ id: flows.id });
  flowAId = f1!.id;
  const [f2] = await db
    .insert(flows)
    .values({ tenantId: tenantAId, name: "Flow Two", triggerType: "event", triggerConfig: {}, steps: [] })
    .returning({ id: flows.id });
  flowA2Id = f2!.id;

  // Memberships (messages require membership_id)
  const contactIds = (
    await db.execute<{ id: string }>(sql`SELECT id FROM contacts WHERE tenant_id = ${tenantAId} ORDER BY external_id`)
  ).rows.map((r) => r.id);

  const [m1] = await db
    .insert(flowMemberships)
    .values({ tenantId: tenantAId, contactId: contactIds[0]!, flowId: flowAId, enteredAt: daysAgo(5) })
    .returning({ id: flowMemberships.id });
  const [m2] = await db
    .insert(flowMemberships)
    .values({ tenantId: tenantAId, contactId: contactIds[1]!, flowId: flowA2Id, enteredAt: daysAgo(5) })
    .returning({ id: flowMemberships.id });

  // Messages in tenant A:
  //   flow one: 4 sent (1 opened, 1 clicked, 1 bounced), 1 failed (never sent)
  //   flow two: 2 sent (1 opened, 1 plain), 1 suppressed
  //   one old message outside a 7-day range (created 10 days ago, sent 10 days ago)
  const msg = (
    overrides: Record<string, unknown>,
  ): typeof lifecycleMessages.$inferInsert => ({
    tenantId: tenantAId,
    contactId: contactIds[0]!,
    flowId: flowAId,
    membershipId: m1!.id,
    status: "sent",
    subject: "s",
    createdAt: daysAgo(2),
    sentAt: daysAgo(2),
    ...overrides,
  });

  await db.insert(lifecycleMessages).values([
    msg({ feedback: "opened" }),
    msg({ feedback: "clicked" }),
    msg({ feedback: "bounced" }),
    msg({}), // plain sent, no feedback
    msg({ status: "failed", sentAt: null, createdAt: daysAgo(1) }),
    msg({ flowId: flowA2Id, membershipId: m2!.id, feedback: "opened", sentAt: daysAgo(3), createdAt: daysAgo(3) }),
    msg({ flowId: flowA2Id, membershipId: m2!.id, sentAt: daysAgo(3), createdAt: daysAgo(3) }),
    msg({ flowId: flowA2Id, membershipId: m2!.id, status: "suppressed", sentAt: null, createdAt: daysAgo(1) }),
    // old: inside 30d, outside 7d
    msg({ sentAt: daysAgo(10), createdAt: daysAgo(10), feedback: "opened" }),
  ]);

  // One message in tenant B (isolation)
  const bContactId = (
    await db.execute<{ id: string }>(sql`SELECT id FROM contacts WHERE tenant_id = ${tenantBId} LIMIT 1`)
  ).rows[0]!.id;
  const [flowB] = await db
    .insert(flows)
    .values({ tenantId: tenantBId, name: "Flow B", triggerType: "event", triggerConfig: {}, steps: [] })
    .returning({ id: flows.id });
  const [membershipB] = await db
    .insert(flowMemberships)
    .values({ tenantId: tenantBId, contactId: bContactId, flowId: flowB!.id, enteredAt: daysAgo(2) })
    .returning({ id: flowMemberships.id });
  await db.insert(lifecycleMessages).values({
    tenantId: tenantBId,
    contactId: bContactId,
    flowId: flowB!.id,
    membershipId: membershipB!.id,
    status: "sent",
    subject: "b",
    sentAt: daysAgo(1),
    createdAt: daysAgo(1),
  });

  // Transitions in tenant A:
  //   2x engaged -> at_risk (2 and 3 days ago)
  //   1x at_risk -> churned (1 day ago)
  //   1x signed_up -> activated (10 days ago: inside 30d, outside 7d)
  const t = (from: string, to: string, ageDays: number, contactIdx: number) => ({
    tenantId: tenantAId,
    contactId: contactIds[contactIdx]!,
    fromState: from,
    toState: to,
    transitionedAt: daysAgo(ageDays),
  });
  await db.insert(lifecycleTransitions).values([
    t("engaged", "at_risk", 2, 2),
    t("engaged", "at_risk", 3, 2),
    t("at_risk", "churned", 1, 3),
    t("signed_up", "activated", 10, 4),
  ]);

  // One transition in tenant B
  const bContact = (await db.execute<{ id: string }>(sql`SELECT id FROM contacts WHERE tenant_id = ${tenantBId} LIMIT 1`)).rows[0]!.id;
  await db.insert(lifecycleTransitions).values({
    tenantId: tenantBId,
    contactId: bContact,
    fromState: "signed_up",
    toState: "engaged",
    transitionedAt: daysAgo(1),
  });
});

afterAll(async () => {
  if (dbAvailable) {
    for (const slug of [TEST_SLUG_A, TEST_SLUG_B]) {
      await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM lifecycle_transitions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM retention_grid_snapshots WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
    }
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("GET /v1/analytics/lifecycle", () => {
  it("returns 401 without a session cookie", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "GET", url: "/v1/analytics/lifecycle" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 for days=0 and days=91", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    for (const bad of ["0", "91"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/analytics/lifecycle?days=${bad}`,
        headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues[0].path).toBe("days");
    }
  });

  it("returns the distribution with the depth matrix and a matching total", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/analytics/lifecycle?days=30",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const byState = new Map(body.distribution.map((r: { state: string }) => [r.state, r]));
    expect(byState.get("engaged").total).toBe(2);
    expect(byState.get("engaged").power).toBe(1);
    expect(byState.get("engaged").regular).toBe(1);
    expect(byState.get("at_risk").total).toBe(1);
    expect(byState.get("at_risk").casual).toBe(1);
    expect(byState.get("churned").total).toBe(1);
    expect(byState.get("churned").unset).toBe(1);
    expect(byState.get("signed_up").minimal).toBe(1);
    expect(body.contacts_total).toBe(5);
  });

  it("counts entries and exits per state within the range", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/lifecycle?days=30",
        headers: { cookie: cookieA },
      })
    ).json();

    const perState = new Map(body.movement.per_state.map((r: { state: string }) => [r.state, r]));
    expect(perState.get("at_risk").entered).toBe(2);
    expect(perState.get("at_risk").exited).toBe(1);
    expect(perState.get("engaged").exited).toBe(2);
    expect(perState.get("churned").entered).toBe(1);
    expect(perState.get("activated").entered).toBe(1);
  });

  it("aggregates edges with counts and returns the day series ascending", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/lifecycle?days=30",
        headers: { cookie: cookieA },
      })
    ).json();

    const edge = body.movement.edges.find(
      (e: { from_state: string; to_state: string }) =>
        e.from_state === "engaged" && e.to_state === "at_risk",
    );
    expect(edge.count).toBe(2);

    const days = body.movement.days.map((d: { day: string }) => d.day);
    const sorted = [...days].sort();
    expect(days).toEqual(sorted);
    const total = body.movement.days.reduce((acc: number, d: { count: number }) => acc + d.count, 0);
    expect(total).toBe(4);
    // direction buckets: 3 transitions into bad states, 1 into a good state
    const pos = body.movement.days.reduce((acc: number, d: { positive: number }) => acc + d.positive, 0);
    const neg = body.movement.days.reduce((acc: number, d: { negative: number }) => acc + d.negative, 0);
    expect(pos).toBe(1); // signed_up -> activated
    expect(neg).toBe(3); // 2x engaged -> at_risk, 1x at_risk -> churned
  });

  it("excludes transitions older than the range", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/lifecycle?days=7",
        headers: { cookie: cookieA },
      })
    ).json();
    const total = body.movement.days.reduce((acc: number, d: { count: number }) => acc + d.count, 0);
    expect(total).toBe(3); // the 10-day-old transition is outside
    const perState = new Map(body.movement.per_state.map((r: { state: string }) => [r.state, r]));
    expect(perState.get("activated")).toBeUndefined();
  });

  it("splits distribution and movement by audience on current payment status", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const get = async (qs: string) =>
      app.inject({ method: "GET", url: `/v1/analytics/lifecycle?days=30${qs}`, headers: { cookie: cookieA } });
    const moved = (body: { movement: { days: Array<{ count: number }> } }) =>
      body.movement.days.reduce((acc, d) => acc + d.count, 0);

    const bad = await get("&audience=paying");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues[0].path).toBe("audience");
    expect((await get("")).json().audience).toBe("all");

    // a3 (both engaged -> at_risk transitions) pays for the duration of this test.
    await db.execute(sql`UPDATE contacts SET payment_status = 'past_due' WHERE tenant_id = ${tenantAId} AND external_id = 'a3'`);
    try {
      const paid = (await get("&audience=paid")).json();
      expect(paid.audience).toBe("paid");
      expect(paid.contacts_total).toBe(1);
      expect(paid.distribution.map((r: { state: string }) => r.state)).toEqual(["at_risk"]);
      expect(moved(paid)).toBe(2);
      expect(paid.movement.edges).toEqual([{ from_state: "engaged", to_state: "at_risk", count: 2 }]);

      const free = (await get("&audience=free")).json();
      expect(free.contacts_total).toBe(4);
      expect(moved(free)).toBe(2); // at_risk -> churned, signed_up -> activated
      expect(free.movement.edges.some((e: { to_state: string }) => e.to_state === "at_risk")).toBe(false);

      const all = (await get("&audience=all")).json();
      expect(all.contacts_total).toBe(5);
      expect(moved(all)).toBe(4);
    } finally {
      await db.execute(sql`UPDATE contacts SET payment_status = 'free' WHERE tenant_id = ${tenantAId} AND external_id = 'a3'`);
    }
  });

  it("isolates tenants", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/lifecycle?days=30",
        headers: { cookie: cookieB },
      })
    ).json();
    expect(body.contacts_total).toBe(1);
    const total = body.movement.days.reduce((acc: number, d: { count: number }) => acc + d.count, 0);
    expect(total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

describe("GET /v1/analytics/sending", () => {
  it("returns 401 without a session cookie", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "GET", url: "/v1/analytics/sending" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 for days=0 and days=91", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    for (const bad of ["0", "91"]) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/analytics/sending?days=${bad}`,
        headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues[0].path).toBe("days");
    }
  });

  it("computes totals correctly across status and feedback", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/analytics/sending?days=30",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const { totals } = res.json();
    expect(totals.sent).toBe(7);       // 4 flow one + 2 flow two + 1 old
    expect(totals.opened).toBe(4);     // feedback opened(2) + clicked(1) + old opened(1)
    expect(totals.clicked).toBe(1);
    expect(totals.bounced).toBe(1);
    expect(totals.suppressed).toBe(1);
    expect(totals.failed).toBe(1);
  });

  it("scopes the day series and totals to the range", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/sending?days=7",
        headers: { cookie: cookieA },
      })
    ).json();
    expect(body.totals.sent).toBe(6); // old send excluded
    const sent = body.days.reduce((acc: number, d: { sent: number }) => acc + d.sent, 0);
    expect(sent).toBe(6);
    const days = body.days.map((d: { day: string }) => d.day);
    expect(days).toEqual([...days].sort());
  });

  it("groups per flow with names ordered by sent desc", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/sending?days=30",
        headers: { cookie: cookieA },
      })
    ).json();
    expect(body.per_flow.length).toBe(2);
    expect(body.per_flow[0].flow_name).toBe("Flow One");
    expect(body.per_flow[0].sent).toBe(5);
    expect(body.per_flow[0].bounced).toBe(1);
    expect(body.per_flow[1].flow_name).toBe("Flow Two");
    expect(body.per_flow[1].sent).toBe(2);
    expect(body.per_flow[1].suppressed).toBe(1);
  });

  it("returns zeroed totals and empty arrays for an empty tenant", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const [t] = await db
      .insert(tenants)
      .values({ name: "Empty", slug: "test-analytics-empty", plan: "free" })
      .returning({ id: tenants.id });
    const [u] = await db
      .insert(users)
      .values({ tenantId: t!.id, email: "e@analytics.test", role: "owner" })
      .returning({ id: users.id });
    const [s] = await db
      .insert(sessions)
      .values({ tenantId: t!.id, userId: u!.id, expiresAt: new Date(Date.now() + 86400_000) })
      .returning({ id: sessions.id });

    const res = await app.inject({
      method: "GET",
      url: "/v1/analytics/sending?days=30",
      headers: { cookie: `claros_session=${s!.id}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.sent).toBe(0);
    expect(body.days).toEqual([]);
    expect(body.per_flow).toEqual([]);

    await db.execute(sql`DELETE FROM sessions WHERE tenant_id = ${t!.id}`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id = ${t!.id}`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${t!.id}`);
  });

  it("isolates tenants", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/sending?days=30",
        headers: { cookie: cookieB },
      })
    ).json();
    expect(body.totals.sent).toBe(1);
    expect(body.per_flow.length).toBe(1);
    expect(body.per_flow[0].flow_name).toBe("Flow B");
  });
});

describe("GET /v1/analytics/retention-grid", () => {
  it("buckets contacts by tenure and recency with paying counts", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Explicit timestamps (default freq 7: cooling 7d, idle 14d, dormant 28d)
    await db.insert(contacts).values([
      // new (<30d tenure) + active (<7d quiet), paying
      { tenantId: tenantAId, externalId: "rg1", email: "rg1@x.dev", lifecycleState: "engaged",
        firstSeenAt: daysAgo(10), lastSeenAt: daysAgo(2), paymentStatus: "paid" },
      // new + active, free
      { tenantId: tenantAId, externalId: "rg2", email: "rg2@x.dev", lifecycleState: "engaged",
        firstSeenAt: daysAgo(5), lastSeenAt: daysAgo(1), paymentStatus: "free" },
      // loyal (>=180d tenure) + dormant (>=28d quiet)
      { tenantId: tenantAId, externalId: "rg3", email: "rg3@x.dev", lifecycleState: "dormant",
        firstSeenAt: daysAgo(200), lastSeenAt: daysAgo(40), paymentStatus: "free" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/v1/analytics/retention-grid",
      headers: { cookie: cookieA },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.natural_frequency_days).toBe(7);
    expect(body.recency_thresholds_days).toEqual({ cooling: 7, idle: 14, dormant: 28 });

    const cell = (t: string, r: string) =>
      body.cells.find((c: { tenure: string; recency: string }) => c.tenure === t && c.recency === r);

    // rg1 + rg2 land in (new, active); rg3 in (loyal, dormant).
    // The 5 seed contacts have null timestamps and fall into the
    // unbounded (loyal, dormant) bucket as well.
    const newActive = cell("new", "active");
    expect(newActive).toBeDefined();
    expect(newActive.count).toBe(2);
    expect(newActive.paying).toBe(1);

    const loyalDormant = cell("loyal", "dormant");
    expect(loyalDormant).toBeDefined();
    expect(loyalDormant.count).toBeGreaterThanOrEqual(1);

    // cleanup the extra contacts so later tests see only the seed set
    await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantAId} AND external_id IN ('rg1', 'rg2', 'rg3')`);

    await app.close();
  });

  it("isolates tenants", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/analytics/retention-grid",
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const total = body.cells.reduce((acc: number, c: { count: number }) => acc + c.count, 0);
    expect(total).toBe(1); // only b1
    expect(body.contacts_total).toBe(1);
    await app.close();
  });
});

describe("GET /v1/analytics/retention-grid/:tenure/:recency/contacts", () => {
  it("returns 401 without a session cookie", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/analytics/retention-grid/new/active/contacts",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 400 for an unknown bucket name", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    for (const url of [
      "/v1/analytics/retention-grid/ancient/active/contacts",
      "/v1/analytics/retention-grid/new/sleepy/contacts",
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("lists the contacts in the cell with keyset pagination", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    // Default rhythm (7d): active <7d quiet. new = <30d tenure.
    await db.insert(contacts).values([
      { tenantId: tenantAId, externalId: "cell1", email: "cell1@x.dev", name: "Cell One",
        lifecycleState: "engaged", firstSeenAt: daysAgo(10), lastSeenAt: daysAgo(2),
        paymentStatus: "paid" },
      { tenantId: tenantAId, externalId: "cell2", email: "cell2@x.dev",
        lifecycleState: "engaged", firstSeenAt: daysAgo(5), lastSeenAt: daysAgo(1) },
      // same tenure, wrong recency (cooling: 7-13d quiet)
      { tenantId: tenantAId, externalId: "cell3", email: "cell3@x.dev",
        lifecycleState: "at_risk", firstSeenAt: daysAgo(8), lastSeenAt: daysAgo(9) },
    ]);

    const page1 = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/retention-grid/new/active/contacts?limit=1",
        headers: { cookie: cookieA },
      })
    ).json();
    expect(page1.contacts.length).toBe(1);
    expect(page1.contacts[0].lifecycle_state).toBe("engaged");
    expect(page1.next_cursor).toBe(page1.contacts[0].id);

    const page2 = (
      await app.inject({
        method: "GET",
        url: `/v1/analytics/retention-grid/new/active/contacts?limit=1&cursor=${page1.next_cursor}`,
        headers: { cookie: cookieA },
      })
    ).json();
    expect(page2.contacts.length).toBe(1);
    expect(page2.contacts[0].id).not.toBe(page1.contacts[0].id);
    expect(page2.next_cursor).toBeNull();

    // The cooling contact is not in this cell; fields come through.
    // (Keyset order follows random UUIDs, so assertions are order-agnostic.)
    const both = [page1.contacts[0], page2.contacts[0]];
    expect(both.map((c: { external_id: string }) => c.external_id).sort()).toEqual(["cell1", "cell2"]);
    expect(both.filter((c: { name: string | null }) => c.name === "Cell One").length).toBe(1);

    // Tenant B sees nobody in this cell (its contact has null timestamps).
    const bodyB = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/retention-grid/new/active/contacts",
        headers: { cookie: cookieB },
      })
    ).json();
    expect(bodyB.contacts).toEqual([]);

    await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantAId} AND external_id IN ('cell1', 'cell2', 'cell3')`);
    await app.close();
  });
});

describe("GET /v1/analytics/retention-grid/:tenure/:recency/trend", () => {
  const dayStr = (n: number) => daysAgo(n).toISOString().slice(0, 10);

  it("returns 400 for an unknown bucket or bad days", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    for (const url of [
      "/v1/analytics/retention-grid/ancient/active/trend",
      "/v1/analytics/retention-grid/new/active/trend?days=0",
      "/v1/analytics/retention-grid/new/active/trend?days=91",
    ]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { cookie: cookieA },
      });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it("serves the snapshot series ascending, scoped to the range and tenant", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    await db.insert(retentionGridSnapshots).values([
      // target cell: two days inside a 30d window, one outside it
      { tenantId: tenantAId, snapshotDate: dayStr(2), tenureBucket: "new", recencyBucket: "active", contactCount: 4, payingCount: 1 },
      { tenantId: tenantAId, snapshotDate: dayStr(1), tenureBucket: "new", recencyBucket: "active", contactCount: 6, payingCount: 2 },
      { tenantId: tenantAId, snapshotDate: dayStr(40), tenureBucket: "new", recencyBucket: "active", contactCount: 1, payingCount: 0 },
      // another cell, must not leak in
      { tenantId: tenantAId, snapshotDate: dayStr(1), tenureBucket: "loyal", recencyBucket: "dormant", contactCount: 9, payingCount: 9 },
      // tenant B's row for the same cell, must not leak in
      { tenantId: tenantBId, snapshotDate: dayStr(1), tenureBucket: "new", recencyBucket: "active", contactCount: 3, payingCount: 0 },
    ]);

    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/retention-grid/new/active/trend?days=30",
        headers: { cookie: cookieA },
      })
    ).json();

    expect(body.range_days).toBe(30);
    expect(body.days.length).toBe(2); // the 40-day-old row is outside
    expect(body.days[0].day).toBe(dayStr(2));
    expect(body.days[0].count).toBe(4);
    expect(body.days[0].paying).toBe(1);
    expect(body.days[1].day).toBe(dayStr(1));
    expect(body.days[1].count).toBe(6);

    const wide = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/retention-grid/new/active/trend?days=90",
        headers: { cookie: cookieA },
      })
    ).json();
    expect(wide.days.length).toBe(3);

    const bodyB = (
      await app.inject({
        method: "GET",
        url: "/v1/analytics/retention-grid/new/active/trend?days=30",
        headers: { cookie: cookieB },
      })
    ).json();
    expect(bodyB.days.length).toBe(1);
    expect(bodyB.days[0].count).toBe(3);

    await db.execute(sql`DELETE FROM retention_grid_snapshots WHERE tenant_id IN (${tenantAId}, ${tenantBId})`);
    await app.close();
  });
});
