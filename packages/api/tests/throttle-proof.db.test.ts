/**
 * Proof 4: PUT /v1/settings/throttle rejects out-of-bounds values with explanation.
 *
 * This test uses the same authenticated-session approach as the other settings
 * tests: buildApp with a real DB, a magic-link login to get a session cookie,
 * then calls the endpoint.
 *
 * Run: npm test (via the normal test runner which loads .env)
 * Requires: DATABASE_URL + Postgres running + ENCRYPTION_KEY set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, users, sessions } from "@claros/db/schema";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[throttle-proof-api] DATABASE_URL is not set.\n` +
      (inCI ? `Set it in the workflow env block.\n` : `Export it or run via npm test.\n`),
  );
}

const TEST_ENCRYPTION_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const SLUG = "test-throttle-proof-api";

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let tenantId: string;
let sessionCookie: string;
let savedEncryptionKey: string | undefined;

beforeAll(async () => {
  savedEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_BASE64;

  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    console.warn(`[throttle-proof-api] DB unreachable - skipping. ${(err as Error).message}`);
    return;
  }

  await cleanup();

  // Create tenant
  const [t] = await db.insert(tenants).values({
    name: "Throttle API Proof",
    slug: SLUG,
    plan: "free",
    settings: { postal_address: "1 Test St, TC 12345" },
  }).returning({ id: tenants.id });
  tenantId = t!.id;

  // Create owner user
  const [u] = await db.insert(users).values({
    tenantId,
    email: `owner-${SLUG}@example.com`,
    role: "owner",
  }).returning({ id: users.id });

  // Create a session directly (same as other settings tests)
  const [s] = await db.insert(sessions).values({
    tenantId,
    userId: u!.id,
    expiresAt: new Date(Date.now() + 86400_000),
  }).returning({ id: sessions.id });
  sessionCookie = `claros_session=${s!.id}`;
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
  await pool.end();
  if (savedEncryptionKey !== undefined) {
    process.env.ENCRYPTION_KEY = savedEncryptionKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
});

async function cleanup() {
  for (const q of [
    sql`DELETE FROM sessions     WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
    sql`DELETE FROM users        WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`,
    sql`DELETE FROM tenants      WHERE slug = ${SLUG}`,
  ]) { await db.execute(q); }
}

describe("Proof 4: PUT /v1/settings/throttle API validation", () => {
  it("rejects max_emails_per_user_per_day=999 (exceeds max 100) with 400 and error text", async () => {
    if (!dbAvailable) return;

    const app = await buildApp({ logger: false, db: db as any, serveDashboard: false });

    const response = await app.inject({
      method: "PUT",
      url: "/v1/settings/throttle",
      headers: { "content-type": "application/json", cookie: sessionCookie },
      body: JSON.stringify({ max_emails_per_user_per_day: 999 }),
    });

    console.log("\n[Proof4] PUT max_emails_per_user_per_day=999");
    console.log("  status:", response.statusCode);
    console.log("  body:  ", response.body);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    // Fastify schema validation message references the field and constraint
    expect(JSON.stringify(body)).toMatch(/max_emails_per_user_per_day|maximum|100/i);

    await app.close();
  });

  it("rejects batch_size_per_tick=0 (below min 1) with 400", async () => {
    if (!dbAvailable) return;

    const app = await buildApp({ logger: false, db: db as any, serveDashboard: false });

    const response = await app.inject({
      method: "PUT",
      url: "/v1/settings/throttle",
      headers: { "content-type": "application/json", cookie: sessionCookie },
      body: JSON.stringify({ batch_size_per_tick: 0 }),
    });

    console.log("\n[Proof4] PUT batch_size_per_tick=0");
    console.log("  status:", response.statusCode);
    console.log("  body:  ", response.body);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(JSON.stringify(body)).toMatch(/batch_size_per_tick|minimum|1/i);

    await app.close();
  });

  it("rejects min_interval_between_emails_hours=200 (exceeds max 168) with 400", async () => {
    if (!dbAvailable) return;

    const app = await buildApp({ logger: false, db: db as any, serveDashboard: false });

    const response = await app.inject({
      method: "PUT",
      url: "/v1/settings/throttle",
      headers: { "content-type": "application/json", cookie: sessionCookie },
      body: JSON.stringify({ min_interval_between_emails_hours: 200 }),
    });

    console.log("\n[Proof4] PUT min_interval_between_emails_hours=200");
    console.log("  status:", response.statusCode);
    console.log("  body:  ", response.body);

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("accepts valid values and returns resolved config", async () => {
    if (!dbAvailable) return;

    const app = await buildApp({ logger: false, db: db as any, serveDashboard: false });

    const response = await app.inject({
      method: "PUT",
      url: "/v1/settings/throttle",
      headers: { "content-type": "application/json", cookie: sessionCookie },
      body: JSON.stringify({
        max_emails_per_user_per_day: 3,
        batch_size_per_tick: 5,
        send_window_start: "08:00",
        send_window_end: "18:00",
      }),
    });

    console.log("\n[Proof4] PUT valid values");
    console.log("  status:", response.statusCode);
    console.log("  body:  ", response.body);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { throttle: Record<string, unknown> };
    expect(body.throttle.max_emails_per_user_per_day).toBe(3);
    expect(body.throttle.batch_size_per_tick).toBe(5);
    expect(body.throttle.send_window_start).toBe("08:00");
    expect(body.throttle.send_window_end).toBe("18:00");

    await app.close();
  });
});
