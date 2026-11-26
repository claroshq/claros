/**
 * Contacts (People) integration tests.
 *
 * Coverage:
 *
 * Happy paths:
 *   - GET /v1/contacts lists contacts for the tenant with profile fields
 *   - GET /v1/contacts/:id returns contact, memberships (with flow names), suppression
 *   - GET /v1/contacts/:id for a contact with no email returns suppression: null
 *   - GET /v1/contacts/:id/timeline merges events, transitions and messages, newest first
 *
 * Auth:
 *   - Requests without a session cookie are rejected with 401 on all three routes
 *
 * Tenant isolation:
 *   - GET /v1/contacts list returns only the calling tenant's contacts
 *   - GET /v1/contacts/:id for another tenant's contact returns 404 (not 403)
 *   - GET /v1/contacts/:id/timeline for another tenant's contact returns 404
 *   - timeline never includes another tenant's rows for the same contact id
 *
 * Search and filters:
 *   - ?search matches email substring (case-insensitive)
 *   - ?search matches name and external_id
 *   - ?search with no match returns an empty page with next_cursor null
 *   - ?lifecycle_state filters exactly
 *   - ?engagement_depth filters exactly
 *   - ?lifecycle_state with an invalid value returns 400 with issues
 *   - ?engagement_depth with an invalid value returns 400 with issues
 *
 * Sorting, A-Z, payment and dates:
 *   - ?sort=name|joined|last_seen with ?order, paged with the sort's cursor
 *   - first page carries total and per-letter counts; ?letter filters by initial
 *   - ?payment_status filters exactly; joined and last seen ranges
 *   - a cursor from another sort is 400; a { created_at, id } cursor still pages
 *
 * Pagination (list):
 *   - two pages are disjoint and together cover all rows
 *   - next_cursor is null on the last page
 *   - empty table returns empty page with next_cursor null
 *
 * Pagination (timeline):
 *   - two pages are disjoint and together cover all rows across all three kinds
 *   - next_cursor is null on the last page
 *
 * Errors:
 *   - GET /v1/contacts/:id with a malformed id returns 404 (not a 500)
 *   - GET /v1/contacts/:id/timeline with a malformed id returns 404
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
  events,
  lifecycleTransitions,
  lifecycleMessages,
  suppressions,
} from "@claros/db/schema";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error(
    `[contacts.test] DATABASE_URL is not set. Set it in .env or export it.`,
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;

let tenantAId: string;
let cookieA: string;
let tenantBId: string;
let cookieB: string;

const TEST_SLUG_A = "test-contacts-a";
const TEST_SLUG_B = "test-contacts-b";

/** Contacts in tenant A */
let contactRichId: string;   // has events, transitions, messages, membership
let contactSparseId: string; // has almost nothing
let contactNoEmailId: string;
let flowAId: string;

const baseTime = Date.now() - 86400_000 * 10;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    if (process.env.CI === "true") {
      throw new Error(`[contacts.test] DATABASE_URL not reachable in CI: ${(err as Error).message}`);
    }
    console.warn("[contacts.test] DATABASE_URL not reachable - integration tests will be skipped.");
    return;
  }

  // Clean up from previous runs (reverse dependency order)
  for (const slug of [TEST_SLUG_A, TEST_SLUG_B]) {
    await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM lifecycle_transitions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM suppressions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }

  // Tenant A
  const [tA] = await db
    .insert(tenants)
    .values({ name: "Test Contacts A", slug: TEST_SLUG_A, plan: "free" })
    .returning({ id: tenants.id });
  tenantAId = tA!.id;
  const [uA] = await db
    .insert(users)
    .values({ tenantId: tenantAId, email: "owner-a@contacts.test", role: "owner" })
    .returning({ id: users.id });
  const [sA] = await db
    .insert(sessions)
    .values({ tenantId: tenantAId, userId: uA!.id, expiresAt: new Date(Date.now() + 86400_000) })
    .returning({ id: sessions.id });
  cookieA = `claros_session=${sA!.id}`;

  // Tenant B
  const [tB] = await db
    .insert(tenants)
    .values({ name: "Test Contacts B", slug: TEST_SLUG_B, plan: "free" })
    .returning({ id: tenants.id });
  tenantBId = tB!.id;
  const [uB] = await db
    .insert(users)
    .values({ tenantId: tenantBId, email: "owner-b@contacts.test", role: "owner" })
    .returning({ id: users.id });
  const [sB] = await db
    .insert(sessions)
    .values({ tenantId: tenantBId, userId: uB!.id, expiresAt: new Date(Date.now() + 86400_000) })
    .returning({ id: sessions.id });
  cookieB = `claros_session=${sB!.id}`;

  // Flow in tenant A (for memberships and messages)
  const [fA] = await db
    .insert(flows)
    .values({
      tenantId: tenantAId,
      name: "Win-Back Flow",
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [],
    })
    .returning({ id: flows.id });
  flowAId = fA!.id;

  // Rich contact: events, transitions, a membership, a message, suppression-free
  const [cRich] = await db
    .insert(contacts)
    .values({
      tenantId: tenantAId,
      externalId: "user-rich-1",
      email: "ada@example.com",
      name: "Ada Lovelace",
      company: "Analytical Engines",
      properties: { plan: "pro", seats: 4 },
      lifecycleState: "at_risk",
      engagementDepth: "regular",
      paymentStatus: "paid",
      firstSeenAt: new Date(baseTime),
      lastSeenAt: new Date(baseTime + 86400_000 * 9),
      createdAt: new Date(baseTime),
    })
    .returning({ id: contacts.id });
  contactRichId = cRich!.id;

  // Sparse contact
  const [cSparse] = await db
    .insert(contacts)
    .values({
      tenantId: tenantAId,
      externalId: "user-sparse-1",
      email: "grace@example.com",
      name: "Grace Hopper",
      lifecycleState: "signed_up",
      engagementDepth: "minimal",
      paymentStatus: "free",
      createdAt: new Date(baseTime + 86400_000 * 2),
    })
    .returning({ id: contacts.id });
  contactSparseId = cSparse!.id;

  // No-email contact
  const [cNoEmail] = await db
    .insert(contacts)
    .values({
      tenantId: tenantAId,
      externalId: "user-noemail-1",
      lifecycleState: "signed_up",
      createdAt: new Date(baseTime + 86400_000 * 3),
    })
    .returning({ id: contacts.id });
  contactNoEmailId = cNoEmail!.id;

  // Events for the rich contact (3)
  for (let i = 0; i < 3; i++) {
    await db.insert(events).values({
      tenantId: tenantAId,
      contactId: contactRichId,
      type: "track",
      eventName: i === 1 ? "plan_upgraded" : `feature_used_${i}`,
      properties: { i },
      timestamp: new Date(baseTime + 86400_000 * (4 + i)),
      receivedAt: new Date(baseTime + 86400_000 * (4 + i)),
    });
  }

  // Transitions for the rich contact (2)
  await db.insert(lifecycleTransitions).values([
    {
      tenantId: tenantAId,
      contactId: contactRichId,
      fromState: "signed_up",
      toState: "activated",
      transitionedAt: new Date(baseTime + 86400_000 * 5),
    },
    {
      tenantId: tenantAId,
      contactId: contactRichId,
      fromState: "engaged",
      toState: "at_risk",
      transitionedAt: new Date(baseTime + 86400_000 * 8),
    },
  ]);

  // Membership + message for the rich contact
  const [mship] = await db
    .insert(flowMemberships)
    .values({
      tenantId: tenantAId,
      contactId: contactRichId,
      flowId: flowAId,
      status: "active",
      currentStep: 1,
      enteredAt: new Date(baseTime + 86400_000 * 8),
    })
    .returning({ id: flowMemberships.id });

  await db.insert(lifecycleMessages).values({
    tenantId: tenantAId,
    contactId: contactRichId,
    flowId: flowAId,
    membershipId: mship!.id,
    flowStepOrder: 1,
    status: "sent",
    feedback: "opened",
    subject: "Still there?",
    sentAt: new Date(baseTime + 86400_000 * 9),
    createdAt: new Date(baseTime + 86400_000 * 9),
  });

  // A suppression for the sparse contact's email
  await db.insert(suppressions).values({
    tenantId: tenantAId,
    email: "grace@example.com",
    reason: "unsubscribe",
    source: "one_click",
  });

  // Contacts in tenant B (isolation fixtures)
  await db.insert(contacts).values({
    tenantId: tenantBId,
    externalId: "user-b-1",
    email: "ada@example.com", // same email as tenant A contact: must stay isolated
    name: "Ada Other",
    lifecycleState: "engaged",
    engagementDepth: "power",
    createdAt: new Date(baseTime + 86400_000),
  });

  // Extra contacts in tenant A for pagination tests (60 -> two pages at limit 50)
  const extra: (typeof contacts.$inferInsert)[] = [];
  for (let i = 0; i < 60; i++) {
    extra.push({
      tenantId: tenantAId,
      externalId: `user-page-${String(i).padStart(3, "0")}`,
      email: `page${i}@example.com`,
      lifecycleState: "engaged",
      engagementDepth: "casual",
      createdAt: new Date(baseTime + 86400_000 * 4 + i * 1000),
    });
  }
  await db.insert(contacts).values(extra);
});

afterAll(async () => {
  if (dbAvailable) {
    for (const slug of [TEST_SLUG_A, TEST_SLUG_B]) {
      await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM events WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM lifecycle_transitions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
      await db.execute(sql`DELETE FROM suppressions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`);
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
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/contacts", () => {
  it("returns 401 without a session cookie", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "GET", url: "/v1/contacts" });
    expect(res.statusCode).toBe(401);
  });

  it("lists contacts for the calling tenant with profile fields", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/contacts?limit=200",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.contacts.length).toBe(63);
    const rich = body.contacts.find((c: { id: string }) => c.id === contactRichId);
    expect(rich.email).toBe("ada@example.com");
    expect(rich.name).toBe("Ada Lovelace");
    expect(rich.lifecycle_state).toBe("at_risk");
    expect(rich.engagement_depth).toBe("regular");
    expect(rich.payment_status).toBe("paid");
    expect(rich.external_id).toBe("user-rich-1");
    // no membership/timeline data in the list row
    expect(rich.properties).toBeUndefined();
  });

  it("never returns another tenant's contacts", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/contacts?limit=200",
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.contacts.length).toBe(1);
    expect(body.contacts[0].name).toBe("Ada Other");
  });

  it("paginates with disjoint pages and a null cursor on the last page", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const page1 = (
      await app.inject({ method: "GET", url: "/v1/contacts", headers: { cookie: cookieA } })
    ).json();
    expect(page1.contacts.length).toBe(50);
    expect(page1.next_cursor).not.toBeNull();

    // newest first: the first row of page 1 is the most recently created
    const times = page1.contacts.map((c: { created_at: string }) =>
      new Date(c.created_at).getTime(),
    );
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeLessThanOrEqual(times[i - 1]!);
    }

    const page2 = (
      await app.inject({
        method: "GET",
        url: `/v1/contacts?after=${encodeURIComponent(page1.next_cursor)}`,
        headers: { cookie: cookieA },
      })
    ).json();
    expect(page2.contacts.length).toBe(13);
    expect(page2.next_cursor).toBeNull();

    // The first page carries the total across all pages; later pages do not.
    expect(page1.total).toBe(63);
    expect(page2.total).toBeUndefined();

    const ids1 = new Set(page1.contacts.map((c: { id: string }) => c.id));
    for (const c of page2.contacts) {
      expect(ids1.has(c.id)).toBe(false);
    }
  });

  it("returns an empty page with null cursor when nothing matches", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/contacts?search=zzz-no-such-person",
      headers: { cookie: cookieA },
    });
    const body = res.json();
    expect(body.contacts).toEqual([]);
    expect(body.next_cursor).toBeNull();
    expect(body.total).toBe(0);
  });

  it("counts the total with search and filters, not only the loaded page", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const all = (
      await app.inject({ method: "GET", url: "/v1/contacts?limit=200", headers: { cookie: cookieA } })
    ).json();
    const engaged = all.contacts.filter((c: { lifecycle_state: string }) => c.lifecycle_state === "engaged").length;
    expect(engaged).toBeGreaterThan(1);

    const page = (
      await app.inject({
        method: "GET",
        url: "/v1/contacts?lifecycle_state=engaged&limit=1",
        headers: { cookie: cookieA },
      })
    ).json();
    expect(page.contacts.length).toBe(1);
    expect(page.total).toBe(engaged);

    const tenantB = (
      await app.inject({ method: "GET", url: "/v1/contacts", headers: { cookie: cookieB } })
    ).json();
    expect(tenantB.total).toBe(1);
  });

  it("matches search against email, name and external_id case-insensitively", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    const byEmail = (
      await app.inject({ method: "GET", url: "/v1/contacts?search=ADA@EXAMPLE", headers: { cookie: cookieA } })
    ).json();
    expect(byEmail.contacts.map((c: { id: string }) => c.id)).toEqual([contactRichId]);

    const byName = (
      await app.inject({ method: "GET", url: "/v1/contacts?search=lovelace", headers: { cookie: cookieA } })
    ).json();
    expect(byName.contacts.map((c: { id: string }) => c.id)).toEqual([contactRichId]);

    const byExt = (
      await app.inject({ method: "GET", url: "/v1/contacts?search=user-rich", headers: { cookie: cookieA } })
    ).json();
    expect(byExt.contacts.map((c: { id: string }) => c.id)).toEqual([contactRichId]);
  });

  it("filters by lifecycle_state exactly", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/contacts?lifecycle_state=signed_up&limit=200",
        headers: { cookie: cookieA },
      })
    ).json();
    const ids = body.contacts.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([contactNoEmailId, contactSparseId].sort());
  });

  it("filters by engagement_depth exactly", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/contacts?engagement_depth=minimal&limit=200",
        headers: { cookie: cookieA },
      })
    ).json();
    expect(body.contacts.map((c: { id: string }) => c.id)).toEqual([contactSparseId]);
  });

  it("combines search and filters", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const body = (
      await app.inject({
        method: "GET",
        url: "/v1/contacts?lifecycle_state=engaged&search=page1&limit=200",
        headers: { cookie: cookieA },
      })
    ).json();
    expect(body.contacts.length).toBeGreaterThan(0);
    for (const c of body.contacts) {
      expect(c.lifecycle_state).toBe("engaged");
      expect(c.email).toContain("page1");
    }
  });

  it("returns 400 with issues for an invalid lifecycle_state", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/contacts?lifecycle_state=bogus",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Validation failed");
    expect(body.issues[0].path).toBe("lifecycle_state");
  });

  it("returns 400 with issues for an invalid engagement_depth", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/contacts?engagement_depth=bogus",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe("engagement_depth");
  });
});

describe("GET /v1/contacts sorting, A-Z, payment and dates", () => {
  type Row = { id: string; name: string | null; email: string | null; external_id: string };
  const display = (c: Row) => (c.name?.trim() ? c.name : (c.email ?? c.external_id)).toLowerCase();

  async function get(url: string) {
    const app = await buildApp({ db, logger: false });
    return app.inject({ method: "GET", url, headers: { cookie: cookieA } });
  }

  /** Every row of a sort, following next_cursor. */
  async function walk(query: string, limit = 25): Promise<Row[]> {
    const rows: Row[] = [];
    let after: string | null = null;
    for (let i = 0; i < 20; i++) {
      const sep = query ? "&" : "";
      const res = await get(
        `/v1/contacts?${query}${sep}limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      rows.push(...body.contacts);
      after = body.next_cursor;
      if (!after) break;
    }
    return rows;
  }

  it("sorts by display name both ways and pages through every contact", async () => {
    if (!dbAvailable) return;
    const asc = await walk("sort=name");
    expect(asc.length).toBe(63);
    expect(new Set(asc.map((c) => c.id)).size).toBe(63);
    expect(display(asc[0]!)).toBe("ada lovelace");
    const names = asc.map(display);
    for (let i = 1; i < names.length; i++) expect(names[i]! >= names[i - 1]!).toBe(true);
    // the contact without a name or email sorts by its external id
    expect(names).toContain("user-noemail-1");

    const desc = await walk("sort=name&order=desc");
    expect(desc.map((c) => c.id)).toEqual(asc.map((c) => c.id).reverse());
  });

  it("sorts by joined and last seen and pages with the sort's cursor", async () => {
    if (!dbAvailable) return;
    const joined = await walk("sort=joined", 10);
    expect(joined.length).toBe(63);
    expect(new Set(joined.map((c) => c.id)).size).toBe(63);
    // Ada joined first (first_seen_at = baseTime), so she is last newest-first
    expect(joined[joined.length - 1]!.id).toBe(contactRichId);
    expect((await walk("sort=joined&order=asc", 10))[0]!.id).toBe(contactRichId);

    const lastSeen = await walk("sort=last_seen", 10);
    expect(lastSeen.length).toBe(63);
    // only Ada has been seen; never-seen contacts come after her
    expect(lastSeen[0]!.id).toBe(contactRichId);
  });

  it("returns the total and per-letter counts on the first page, and filters by letter", async () => {
    if (!dbAvailable) return;
    const all = (await get("/v1/contacts")).json();
    expect(all.total).toBe(63);
    expect(all.letters).toEqual({ a: 1, g: 1, p: 60, u: 1 });

    const p = (await get("/v1/contacts?letter=P&limit=200")).json();
    expect(p.total).toBe(60);
    expect(p.contacts.length).toBe(60);
    expect(p.contacts.every((c: Row) => display(c).startsWith("p"))).toBe(true);
    // counts ignore the letter filter, so the A-Z bar keeps every letter
    expect(p.letters).toEqual({ a: 1, g: 1, p: 60, u: 1 });

    const other = (await get("/v1/contacts?letter=%23")).json();
    expect(other.contacts).toEqual([]);
    expect(other.total).toBe(0);

    const page2 = (await get(`/v1/contacts?after=${encodeURIComponent(all.next_cursor)}`)).json();
    expect(page2.letters).toBeUndefined();

    const bad = await get("/v1/contacts?letter=ab");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues[0].path).toBe("letter");
  });

  it("filters by payment status", async () => {
    if (!dbAvailable) return;
    const paid = (await get("/v1/contacts?payment_status=paid")).json();
    expect(paid.contacts.map((c: Row) => c.id)).toEqual([contactRichId]);
    expect(paid.total).toBe(1);
    expect(paid.letters).toEqual({ a: 1 });

    const bad = await get("/v1/contacts?payment_status=gold");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues[0].path).toBe("payment_status");
  });

  it("filters by joined and last seen ranges, with dates or date-times", async () => {
    if (!dbAvailable) return;
    const iso = (ms: number) => new Date(ms).toISOString();
    // joined = first seen, else created: Ada at baseTime, Grace +2d, no-email +3d, page contacts +4d
    const late = (await get(`/v1/contacts?joined_after=${iso(baseTime + 86400_000 * 3.5)}`)).json();
    expect(late.total).toBe(60);
    const early = (await get(`/v1/contacts?joined_before=${iso(baseTime + 86400_000 * 2.5)}&sort=joined`)).json();
    expect(early.contacts.map((c: Row) => c.id)).toEqual([contactSparseId, contactRichId]);

    // only Ada has a last_seen_at; never-seen contacts are outside every range
    const seen = (await get(`/v1/contacts?last_seen_after=${iso(baseTime)}`)).json();
    expect(seen.contacts.map((c: Row) => c.id)).toEqual([contactRichId]);
    const notSeen = (await get(`/v1/contacts?last_seen_before=${iso(baseTime)}`)).json();
    expect(notSeen.total).toBe(0);

    const dateOnly = await get("/v1/contacts?joined_after=2000-01-01");
    expect(dateOnly.statusCode).toBe(200);
    expect(dateOnly.json().total).toBe(63);

    const bad = await get("/v1/contacts?joined_before=yesterday");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues[0].path).toBe("joined_before");
  });

  it("rejects a cursor from another sort and still reads cursors from before sorting", async () => {
    if (!dbAvailable) return;
    const byName = (await get("/v1/contacts?sort=name&limit=5")).json();
    const mismatch = await get(`/v1/contacts?limit=5&after=${encodeURIComponent(byName.next_cursor)}`);
    expect(mismatch.statusCode).toBe(400);

    // A { created_at, id } cursor as earlier versions issued pages the default order.
    const first = (await get("/v1/contacts?limit=5")).json();
    const last = first.contacts[4];
    const legacy = Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString("base64url");
    const next = (await get(`/v1/contacts?limit=5&after=${legacy}`)).json();
    const viaNew = (await get(`/v1/contacts?limit=5&after=${encodeURIComponent(first.next_cursor)}`)).json();
    expect(next.contacts.map((c: Row) => c.id)).toEqual(viaNew.contacts.map((c: Row) => c.id));

    // A tampered cursor is unreadable and starts from the first page, never a 500.
    for (const payload of [
      { s: "joined", o: "desc", k: "not a date", id: last.id },
      { s: "name", o: "asc", k: "a", id: "not-a-uuid" },
      { created_at: "garbage", id: last.id },
    ]) {
      const cursor = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const sort = "s" in payload ? `&sort=${payload.s}&order=${payload.o}` : "";
      const res = await get(`/v1/contacts?limit=5${sort}&after=${cursor}`);
      expect(res.statusCode).toBe(200);
    }

    const bad = await get("/v1/contacts?sort=email");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues[0].path).toBe("sort");
  });

  it("lists first_seen_at with each contact", async () => {
    if (!dbAvailable) return;
    const paid = (await get("/v1/contacts?payment_status=paid")).json();
    expect(new Date(paid.contacts[0].first_seen_at).getTime()).toBe(baseTime);
    expect(paid.contacts[0].sort_key).toBeUndefined();
  });
});

describe("GET /v1/contacts bucket filters", () => {
  // Bucket boundaries use the database clock (default rhythm 7d:
  // active <7d quiet, cooling 7-13d, dormant 28d+; tenure new <30d,
  // loyal 180d+), so fixture timestamps are relative to real now.
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);

  it("returns 400 with issues for an invalid bucket name", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    for (const url of [
      "/v1/contacts?tenure_bucket=ancient",
      "/v1/contacts?recency_bucket=sleepy",
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

  it("filters by tenure and recency buckets, alone and combined", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });

    await db.insert(contacts).values([
      // new + active
      { tenantId: tenantAId, externalId: "bf1", email: "bf1@x.dev",
        lifecycleState: "engaged", firstSeenAt: daysAgo(5), lastSeenAt: daysAgo(2) },
      // new + cooling
      { tenantId: tenantAId, externalId: "bf2", email: "bf2@x.dev",
        lifecycleState: "at_risk", firstSeenAt: daysAgo(8), lastSeenAt: daysAgo(9) },
      // loyal + dormant
      { tenantId: tenantAId, externalId: "bf3", email: "bf3@x.dev",
        lifecycleState: "dormant", firstSeenAt: daysAgo(200), lastSeenAt: daysAgo(40) },
    ]);

    const get = async (url: string, cookie: string) =>
      (
        await app.inject({ method: "GET", url, headers: { cookie } })
      ).json();
    const ids = (body: { contacts: Array<{ external_id: string }> }) =>
      body.contacts.map((c) => c.external_id).sort();

    // Combined: exactly the (new, active) cell. The rich fixture contact
    // (first_seen 10d ago, last_seen 1d ago) sits in this cell too.
    const cell = await get(
      "/v1/contacts?tenure_bucket=new&recency_bucket=active&limit=200",
      cookieA,
    );
    expect(ids(cell)).toEqual(["bf1", "user-rich-1"]);

    // Tenure alone: rich + bf1 + bf2.
    const tenureOnly = await get("/v1/contacts?tenure_bucket=new&limit=200", cookieA);
    expect(ids(tenureOnly)).toEqual(["bf1", "bf2", "user-rich-1"]);

    // Recency alone: only bf3 is dormant.
    const recencyOnly = await get("/v1/contacts?recency_bucket=dormant&limit=200", cookieA);
    expect(ids(recencyOnly)).toEqual(["bf3"]);

    // Bucket filters compose with the existing filters.
    const composed = await get(
      "/v1/contacts?tenure_bucket=new&lifecycle_state=engaged&limit=200",
      cookieA,
    );
    expect(ids(composed)).toEqual(["bf1"]);

    // Tenant isolation: B's only contact has null timestamps.
    const tenantB = await get("/v1/contacts?tenure_bucket=new&limit=200", cookieB);
    expect(tenantB.contacts).toEqual([]);

    await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantAId} AND external_id IN ('bf1', 'bf2', 'bf3')`);
    await app.close();
  });
});

describe("GET /v1/contacts/:id", () => {
  it("returns 401 without a session cookie", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "GET", url: `/v1/contacts/${contactRichId}` });
    expect(res.statusCode).toBe(401);
  });

  it("returns the contact with memberships and suppression state", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: `/v1/contacts/${contactRichId}`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.contact.id).toBe(contactRichId);
    expect(body.contact.properties).toEqual({ plan: "pro", seats: 4 });
    expect(body.memberships.length).toBe(1);
    expect(body.memberships[0].flow_name).toBe("Win-Back Flow");
    expect(body.memberships[0].status).toBe("active");
    expect(body.memberships[0].current_step).toBe(1);
    expect(body.suppression).toBeNull();
  });

  it("returns suppression when the contact's email is suppressed", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: `/v1/contacts/${contactSparseId}`,
      headers: { cookie: cookieA },
    });
    const body = res.json();
    expect(body.suppression).not.toBeNull();
    expect(body.suppression.reason).toBe("unsubscribe");
  });

  it("returns suppression: null for a contact with no email", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: `/v1/contacts/${contactNoEmailId}`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().suppression).toBeNull();
  });

  it("returns 404 for another tenant's contact", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: `/v1/contacts/${contactRichId}`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a malformed id", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/contacts/not-a-uuid",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /v1/contacts/:id/timeline", () => {
  it("returns 401 without a session cookie", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({ method: "GET", url: `/v1/contacts/${contactRichId}/timeline` });
    expect(res.statusCode).toBe(401);
  });

  it("merges events, transitions and messages newest-first with per-kind shapes", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: `/v1/contacts/${contactRichId}/timeline`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(6);

    const kinds = body.items.map((i: { kind: string }) => i.kind);
    expect(kinds).toContain("event");
    expect(kinds).toContain("transition");
    expect(kinds).toContain("message");

    // newest first: message (day+9) leads
    expect(body.items[0].kind).toBe("message");
    expect(body.items[0].subject).toBe("Still there?");
    expect(body.items[0].feedback).toBe("opened");
    expect(body.items[0].flow_name).toBe("Win-Back Flow");

    // descending order across the merge
    const times = body.items.map((i: { occurred_at: string }) => new Date(i.occurred_at).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeLessThanOrEqual(times[i - 1]!);
    }

    const transition = body.items.find((i: { kind: string }) => i.kind === "transition" && i.to_state === "at_risk");
    expect(transition.from_state).toBe("engaged");

    const ev = body.items.find((i: { kind: string }) => i.kind === "event" && i.event_name === "plan_upgraded");
    expect(ev.event_type).toBe("track");
    expect(ev.properties).toEqual({ i: 1 });
  });

  it("returns an empty page for a contact with no activity", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: `/v1/contacts/${contactSparseId}/timeline`,
      headers: { cookie: cookieA },
    });
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("paginates across kinds with disjoint pages and a null cursor at the end", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const page1 = (
      await app.inject({
        method: "GET",
        url: `/v1/contacts/${contactRichId}/timeline?limit=4`,
        headers: { cookie: cookieA },
      })
    ).json();
    expect(page1.items.length).toBe(4);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = (
      await app.inject({
        method: "GET",
        url: `/v1/contacts/${contactRichId}/timeline?limit=4&after=${encodeURIComponent(page1.next_cursor)}`,
        headers: { cookie: cookieA },
      })
    ).json();
    expect(page2.items.length).toBe(2);
    expect(page2.next_cursor).toBeNull();

    const ids1 = new Set(page1.items.map((i: { id: string }) => i.id));
    for (const item of page2.items) {
      expect(ids1.has(item.id)).toBe(false);
    }
    // union covers all six rows
    expect(page1.items.length + page2.items.length).toBe(6);
  });

  it("returns 404 for another tenant's contact", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: `/v1/contacts/${contactRichId}/timeline`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a malformed id", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ db, logger: false });
    const res = await app.inject({
      method: "GET",
      url: "/v1/contacts/not-a-uuid/timeline",
      headers: { cookie: cookieA },
    });
    expect(res.statusCode).toBe(404);
  });
});
