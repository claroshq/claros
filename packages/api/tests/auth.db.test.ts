/**
 * Auth system tests - magic link flow.
 *
 * These are integration tests requiring a Postgres connection.
 * They test the full auth lifecycle:
 * - Token generation and verification
 * - Single-use enforcement (reused token)
 * - Expired token rejection
 * - Tampered token rejection
 * - Unknown email handling
 * - Session creation and validation
 * - Console fallback behavior (stdout only, never in response body)
 *
 * Run with: npm test (requires local Postgres from docker-compose).
 *
 * When no Postgres is reachable: integration tests skip with a visible message;
 * unit tests (token utilities, isConsoleLoginAllowed) always run.
 * In CI (CI=true): connection failure is fatal.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import {
  tenants,
  users,
  sessions,
  magicLinkTokens,
  transportConfigs,
} from "@claros/db/schema";
import { encrypt, parseEncryptionKey } from "@claros/adapters";
import { generateToken, hashToken, isConsoleLoginAllowed, SESSION_COOKIE_NAME } from "../src/routes/auth.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[auth.test] DATABASE_URL is not set.\n\n` +
    `This test requires a Postgres connection.\n` +
    (inCI
      ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
      : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let testTenantId: string;
let testUserId: string;
let dbAvailable = false;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    const inCI = process.env.CI === "true";
    if (inCI) {
      throw new Error(
        `[auth.test] DATABASE_URL is not reachable in CI.\n` +
        `URL: ${TEST_DB_URL}\n` +
        `Cause: ${(err as Error).message}\n\n` +
        `The CI workflow must include a Postgres service and apply migrations.\n` +
        `See .github/workflows/ci.yml for the expected setup.`
      );
    }
    console.warn("[auth.test] DATABASE_URL not reachable - integration tests will be skipped.");
    console.warn("[auth.test] To run: start local Postgres (docker compose up postgres).");
    return;
  }

  // Clean up any test data from previous runs
  await db.execute(sql`DELETE FROM magic_link_tokens WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-auth')`);
  await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-auth')`);
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-auth')`);
  await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'test-auth')`);
  await db.execute(sql`DELETE FROM tenants WHERE slug = 'test-auth'`);

  // Create test tenant and user
  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Auth", slug: "test-auth", plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;

  const [user] = await db
    .insert(users)
    .values({ tenantId: testTenantId, email: "test@example.com", role: "owner" })
    .returning({ id: users.id });
  testUserId = user!.id;
});

afterAll(async () => {
  if (!dbAvailable) {
    await pool.end();
    return;
  }
  // Clean up
  await db.execute(sql`DELETE FROM magic_link_tokens WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM sessions WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM users WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${testTenantId}`);
  await pool.end();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  // Clean tokens and sessions between tests
  await db.execute(sql`DELETE FROM magic_link_tokens WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM sessions WHERE tenant_id = ${testTenantId}`);
});

/**
 * Helper: create a valid token directly in the DB and return the raw token.
 * Bypasses the login endpoint to get a usable token for verify/session tests.
 */
async function createTestToken(ttlMinutes = 10): Promise<string> {
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await db.insert(magicLinkTokens).values({
    tenantId: testTenantId,
    userId: testUserId,
    tokenHash: hash,
    expiresAt,
  });
  return raw;
}

describe("database availability sentinel", () => {
  it("database unavailable: integration tests skipped", () => {
    if (dbAvailable) return;
    console.warn("[auth.test] All DB integration tests skipped - no database.");
    expect(true).toBe(true);
  });
});

describe("token utilities", () => {
  it("generateToken returns raw and hash of correct lengths", () => {
    const { raw, hash } = generateToken();
    // 32 bytes base64url = 43 chars
    expect(raw.length).toBe(43);
    // SHA-256 hex = 64 chars
    expect(hash.length).toBe(64);
  });

  it("hashToken produces same hash for same input", () => {
    const raw = "test-token-value";
    expect(hashToken(raw)).toBe(hashToken(raw));
  });

  it("hashToken produces different hash for different input", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
});

describe("isConsoleLoginAllowed", () => {
  const originalEnv = process.env.NODE_ENV;

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("returns false when NODE_ENV is undefined", () => {
    delete process.env.NODE_ENV;
    expect(isConsoleLoginAllowed()).toBe(false);
  });

  it("returns false when NODE_ENV is production", () => {
    process.env.NODE_ENV = "production";
    expect(isConsoleLoginAllowed()).toBe(false);
  });

  it("returns true when NODE_ENV is development", () => {
    process.env.NODE_ENV = "development";
    expect(isConsoleLoginAllowed()).toBe(true);
  });

  it("returns true when NODE_ENV is test", () => {
    process.env.NODE_ENV = "test";
    expect(isConsoleLoginAllowed()).toBe(true);
  });
});

describe("POST /auth/login", () => {
  it("returns generic message for unknown email (no enumeration)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@example.com" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toContain("login link has been sent");
    // Must NEVER contain a loginUrl in the response body
    expect(body.loginUrl).toBeUndefined();
    await app.close();
  });

  it("returns message without leaking URL in response (console only)", async () => {
    if (!dbAvailable) return;
    process.env.NODE_ENV = "test";
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "test@example.com" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toBe("Login link printed to server console.");
    // URL must NOT be in the response body - console fallback is stdout only
    expect(body.loginUrl).toBeUndefined();
    await app.close();
  });

  it("creates a token in the database on valid login", async () => {
    if (!dbAvailable) return;
    process.env.NODE_ENV = "test";
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "test@example.com" },
    });

    // Verify a token was created in the DB
    const tokens = await db
      .select({ id: magicLinkTokens.id })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.userId, testUserId));
    expect(tokens.length).toBe(1);

    await app.close();
  });

  it("normalizes email to lowercase", async () => {
    if (!dbAvailable) return;
    process.env.NODE_ENV = "test";
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "TEST@EXAMPLE.COM" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should find the user (email stored as lowercase) and create token
    expect(body.message).toBe("Login link printed to server console.");
    await app.close();
  });
});

/**
 * Helper: redeem a token via POST /auth/verify as the interstitial form does
 * (application/x-www-form-urlencoded body).
 */
async function postVerify(app: Awaited<ReturnType<typeof buildApp>>, rawToken: string) {
  return app.inject({
    method: "POST",
    url: "/auth/verify",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `token=${encodeURIComponent(rawToken)}`,
  });
}

describe("GET /auth/verify (interstitial)", () => {
  it("shows the confirmation page for a valid token and does NOT consume it", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({
      logger: false,
      db,
      baseUrl: "http://localhost:3000",
      dashboardUrl: "http://localhost:3000",
    });
    const rawToken = await createTestToken();

    const res = await app.inject({
      method: "GET",
      url: `/auth/verify?token=${rawToken}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain("test@example.com");
    expect(res.body).toContain('action="/auth/verify"');
    expect(res.body).toContain(encodeURIComponent(rawToken));

    // The token must NOT be consumed by the GET (prefetch safety).
    const tokens = await db
      .select({ consumedAt: magicLinkTokens.consumedAt })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.userId, testUserId));
    expect(tokens[0]!.consumedAt).toBeNull();

    // No session is created and no cookie is set by the GET.
    expect(res.cookies.find((c: { name: string }) => c.name === SESSION_COOKIE_NAME)).toBeUndefined();

    await app.close();
  });

  it("survives repeated prefetch GETs: the link still works afterwards", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({
      logger: false,
      db,
      baseUrl: "http://localhost:3000",
      dashboardUrl: "http://localhost:3000",
    });
    const rawToken = await createTestToken();

    // A scanner GETs the link twice before the user clicks.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "GET",
        url: `/auth/verify?token=${rawToken}`,
      });
      expect(res.statusCode).toBe(200);
    }

    // The user then completes the login via the form POST.
    const postRes = await postVerify(app, rawToken);
    expect(postRes.statusCode).toBe(302);
    expect(postRes.headers["location"]).toBe("http://localhost:3000/");

    await app.close();
  });

  it("rejects a consumed token: 302 to dashboardUrl/login?error=invalid_link", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({
      logger: false,
      db,
      baseUrl: "http://localhost:3000",
      dashboardUrl: "http://localhost:3000",
    });
    const rawToken = await createTestToken();

    const postRes = await postVerify(app, rawToken);
    expect(postRes.statusCode).toBe(302);

    const res = await app.inject({
      method: "GET",
      url: `/auth/verify?token=${rawToken}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("http://localhost:3000/login?error=invalid_link");

    await app.close();
  });

  it("rejects an expired token: 302 to dashboardUrl/login?error=invalid_link", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({
      logger: false,
      db,
      baseUrl: "http://localhost:3000",
      dashboardUrl: "http://localhost:3000",
    });

    // Manually insert an expired token
    const { raw, hash } = generateToken();
    const expiredAt = new Date(Date.now() - 60 * 1000); // 1 minute ago
    await db.insert(magicLinkTokens).values({
      tenantId: testTenantId,
      userId: testUserId,
      tokenHash: hash,
      expiresAt: expiredAt,
    });

    const res = await app.inject({
      method: "GET",
      url: `/auth/verify?token=${raw}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("http://localhost:3000/login?error=invalid_link");

    await app.close();
  });

  it("rejects a tampered token: 302 to dashboardUrl/login?error=invalid_link", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({
      logger: false,
      db,
      baseUrl: "http://localhost:3000",
      dashboardUrl: "http://localhost:3000",
    });

    const res = await app.inject({
      method: "GET",
      url: "/auth/verify?token=completely-fabricated-token-that-does-not-exist",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("http://localhost:3000/login?error=invalid_link");

    await app.close();
  });

  it("rejects an empty token: 302 to dashboardUrl/login?error=invalid_link", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({
      logger: false,
      db,
      baseUrl: "http://localhost:3000",
      dashboardUrl: "http://localhost:3000",
    });

    const res = await app.inject({
      method: "GET",
      url: "/auth/verify?token=",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("http://localhost:3000/login?error=invalid_link");

    await app.close();
  });
});

describe("POST /auth/verify (form submit)", () => {
  it("verifies a valid token: 302 to dashboardUrl/ with session cookie set", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({
      logger: false,
      db,
      baseUrl: "http://localhost:3000",
      dashboardUrl: "http://localhost:3000",
    });
    const rawToken = await createTestToken();

    const verifyRes = await postVerify(app, rawToken);
    // 302 redirect to dashboardUrl/
    expect(verifyRes.statusCode).toBe(302);
    expect(verifyRes.headers["location"]).toBe("http://localhost:3000/");

    // Session cookie is set in the redirect response
    const cookies = verifyRes.cookies;
    const sessionCookie = cookies.find(
      (c: { name: string }) => c.name === SESSION_COOKIE_NAME,
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie!.httpOnly).toBe(true);
    expect(sessionCookie!.sameSite).toBe("Lax");

    await app.close();
  });

  it("rejects a reused token (single-use enforcement): 302 to dashboardUrl/login?error=invalid_link", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({
      logger: false,
      db,
      baseUrl: "http://localhost:3000",
      dashboardUrl: "http://localhost:3000",
    });
    const rawToken = await createTestToken();

    // First use - should succeed with 302 to /
    const res1 = await postVerify(app, rawToken);
    expect(res1.statusCode).toBe(302);
    expect(res1.headers["location"]).toBe("http://localhost:3000/");

    // Second use - should fail with 302 to /login?error=invalid_link
    const res2 = await postVerify(app, rawToken);
    expect(res2.statusCode).toBe(302);
    expect(res2.headers["location"]).toBe("http://localhost:3000/login?error=invalid_link");

    await app.close();
  });

  it("rejects an expired token: 302 to dashboardUrl/login?error=invalid_link", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({
      logger: false,
      db,
      baseUrl: "http://localhost:3000",
      dashboardUrl: "http://localhost:3000",
    });

    const { raw, hash } = generateToken();
    const expiredAt = new Date(Date.now() - 60 * 1000); // 1 minute ago
    await db.insert(magicLinkTokens).values({
      tenantId: testTenantId,
      userId: testUserId,
      tokenHash: hash,
      expiresAt: expiredAt,
    });

    const res = await postVerify(app, raw);
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("http://localhost:3000/login?error=invalid_link");

    await app.close();
  });
});

describe("GET /auth/me", () => {
  it("returns 401 without session cookie", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns user info with valid session", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({
      logger: false,
      db,
      baseUrl: "http://localhost:3000",
      dashboardUrl: "http://localhost:3000",
    });
    const rawToken = await createTestToken();

    // Redeem the token via POST (the interstitial form action) to get the
    // session cookie from the redirect response.
    const verifyRes = await postVerify(app, rawToken);
    expect(verifyRes.statusCode).toBe(302);
    const sessionCookie = verifyRes.cookies.find(
      (c: { name: string }) => c.name === SESSION_COOKIE_NAME,
    )!;

    // Use session to get /auth/me
    const meRes = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie.value },
    });
    expect(meRes.statusCode).toBe(200);
    const body = JSON.parse(meRes.body);
    expect(body.user.email).toBe("test@example.com");
    expect(body.user.tenantId).toBe(testTenantId);

    await app.close();
  });

  it("returns 401 for expired session", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Manually insert an expired session
    const [session] = await db
      .insert(sessions)
      .values({
        tenantId: testTenantId,
        userId: testUserId,
        expiresAt: new Date(Date.now() - 1000), // already expired
      })
      .returning({ id: sessions.id });

    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: session!.id },
    });
    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it("returns 401 when session exists but user row is gone", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // Insert a session referencing a non-existent user UUID.
    // We bypass the FK constraint using session_replication_role to simulate
    // a race condition or cascade-then-stale-cookie scenario.
    const fakeUserId = "00000000-0000-0000-0000-000000000099";
    const futureExpiry = new Date(Date.now() + 86400000); // 1 day from now
    await db.execute(sql`SET session_replication_role = 'replica'`);
    const [orphanSession] = await db
      .insert(sessions)
      .values({
        tenantId: testTenantId,
        userId: fakeUserId,
        expiresAt: futureExpiry,
      })
      .returning({ id: sessions.id });
    await db.execute(sql`SET session_replication_role = 'origin'`);

    // The session exists and is not expired, but the user row is gone.
    // The tenant plugin's INNER JOIN on users must reject this.
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: orphanSession!.id },
    });
    expect(res.statusCode).toBe(401);

    // Clean up the orphan row
    await db.execute(sql`SET session_replication_role = 'replica'`);
    await db.delete(sessions).where(eq(sessions.id, orphanSession!.id));
    await db.execute(sql`SET session_replication_role = 'origin'`);

    await app.close();
  });
});

describe("POST /auth/logout", () => {
  it("clears the session cookie and destroys session", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
    const rawToken = await createTestToken();

    // Redeem token to get session
    const verifyRes = await postVerify(app, rawToken);
    const sessionCookie = verifyRes.cookies.find(
      (c: { name: string }) => c.name === SESSION_COOKIE_NAME,
    )!;

    // Logout
    const logoutRes = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie.value },
    });
    expect(logoutRes.statusCode).toBe(200);

    // Verify session is gone
    const meRes = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie.value },
    });
    expect(meRes.statusCode).toBe(401);

    await app.close();
  });
});

describe("authenticated /v1 scope", () => {
  it("returns 404 for /v1 routes (no routes registered yet)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });

    // An unknown /v1 path is a 404 (auth checks run only on matched routes).
    // Once routes are added (task 7+), the preHandler will reject unauthenticated requests.
    const res = await app.inject({
      method: "GET",
      url: "/v1/anything",
    });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it("tenant is resolved for authenticated requests (via /auth/me)", async () => {
    if (!dbAvailable) return;
    const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
    const rawToken = await createTestToken();

    const verifyRes = await postVerify(app, rawToken);
    const sessionCookie = verifyRes.cookies.find(
      (c: { name: string }) => c.name === SESSION_COOKIE_NAME,
    )!;

    // Verify tenant is resolved via /auth/me which shows tenantId
    const meRes = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: sessionCookie.value },
    });
    expect(meRes.statusCode).toBe(200);
    const body = JSON.parse(meRes.body);
    expect(body.user.tenantId).toBe(testTenantId);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Magic link email delivery via transport
// ---------------------------------------------------------------------------

const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function encryptCredentials(creds: { apiKey: string }): string {
  const key = parseEncryptionKey(TEST_ENCRYPTION_KEY);
  return encrypt(JSON.stringify(creds), key);
}

describe("POST /auth/login - email delivery via transport", () => {
  let savedEncryptionKey: string | undefined;

  beforeAll(() => {
    savedEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  afterAll(() => {
    if (savedEncryptionKey !== undefined) {
      process.env.ENCRYPTION_KEY = savedEncryptionKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    // Clean transport configs and tokens between tests
    await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${testTenantId}`);
    await db.execute(sql`DELETE FROM magic_link_tokens WHERE tenant_id = ${testTenantId}`);
  });

  async function insertTransportConfig() {
    const encrypted = encryptCredentials({ apiKey: "re_test_fake_key" });
    await db.execute(sql`
      INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email, from_name)
      VALUES (${testTenantId}::uuid, 'resend', ${encrypted}::jsonb, true, 'noreply@test.example.com', 'Test App')
    `);
  }

  it("sends login link via transport when configured (does not print to console)", async () => {
    if (!dbAvailable) return;
    process.env.NODE_ENV = "test";
    await insertTransportConfig();

    // Mock fetch to simulate Resend accepting the email
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-msg-id-123" }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "test@example.com" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Generic message (does not reveal whether email was sent or printed)
      expect(body.message).toBe("If that email is registered, a login link has been sent.");

      // Fetch was called (email sent)
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.resend.com/emails");
      const reqBody = JSON.parse(opts.body as string);
      expect(reqBody.to).toEqual(["test@example.com"]);
      expect(reqBody.from).toContain("noreply@test.example.com");
      expect(reqBody.subject).toBe("Your login link");
      expect(reqBody.html).toContain("/auth/verify?token=");
      expect(reqBody.text).toContain("/auth/verify?token=");
      // No compliance headers (transactional email)
      expect(reqBody.headers).toEqual({});

      // Console was NOT used to print the link
      const linkPrinted = consoleSpy.mock.calls.some(
        (args) => args.some((a) => typeof a === "string" && a.includes("/auth/verify?token=")),
      );
      expect(linkPrinted).toBe(false);

      await app.close();
    } finally {
      globalThis.fetch = originalFetch;
      consoleSpy.mockRestore();
    }
  });

  it("falls back to console when send fails (transient error)", async () => {
    if (!dbAvailable) return;
    process.env.NODE_ENV = "test";
    await insertTransportConfig();

    // Mock fetch to simulate a transient failure
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ name: "internal_server_error", message: "boom", statusCode: 500 }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "test@example.com" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Falls back to console
      expect(body.message).toBe("Login link printed to server console.");

      // Console WAS used because send failed
      const linkPrinted = consoleSpy.mock.calls.some(
        (args) => args.some((a) => typeof a === "string" && a.includes("/auth/verify?token=")),
      );
      expect(linkPrinted).toBe(true);

      await app.close();
    } finally {
      globalThis.fetch = originalFetch;
      consoleSpy.mockRestore();
    }
  });

  it("falls back to console when fetch throws (network error)", async () => {
    if (!dbAvailable) return;
    process.env.NODE_ENV = "test";
    await insertTransportConfig();

    // Mock fetch to throw (network failure)
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "test@example.com" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("Login link printed to server console.");

      // Console fallback used
      const linkPrinted = consoleSpy.mock.calls.some(
        (args) => args.some((a) => typeof a === "string" && a.includes("/auth/verify?token=")),
      );
      expect(linkPrinted).toBe(true);

      await app.close();
    } finally {
      globalThis.fetch = originalFetch;
      consoleSpy.mockRestore();
    }
  });

  it("with no transport: prints to console without attempting send", async () => {
    if (!dbAvailable) return;
    process.env.NODE_ENV = "test";
    // No transport config inserted

    const fetchMock = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "test@example.com" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.message).toBe("Login link printed to server console.");

      // fetch was never called (no transport, no send attempt)
      expect(fetchMock).not.toHaveBeenCalled();

      await app.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("email has no compliance headers or unsubscribe footer (transactional)", async () => {
    if (!dbAvailable) return;
    process.env.NODE_ENV = "test";
    await insertTransportConfig();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "msg-id" }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
      await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "test@example.com" },
      });

      const reqBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
      // No List-Unsubscribe in headers
      expect(reqBody.headers["List-Unsubscribe"]).toBeUndefined();
      expect(reqBody.headers["List-Unsubscribe-Post"]).toBeUndefined();
      // No unsubscribe link or postal address in the body
      expect(reqBody.html).not.toContain("unsubscribe");
      expect(reqBody.html).not.toContain("Unsubscribe");
      expect(reqBody.text).not.toContain("unsubscribe");
      expect(reqBody.text).not.toContain("To unsubscribe:");

      await app.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("suppressed address still receives login link (auth bypasses suppression)", async () => {
    if (!dbAvailable) return;
    process.env.NODE_ENV = "test";
    await insertTransportConfig();

    // Add test@example.com to suppression list
    await db.execute(sql`
      INSERT INTO suppressions (tenant_id, email, reason, source)
      VALUES (${testTenantId}::uuid, 'test@example.com', 'unsubscribe', 'one_click')
      ON CONFLICT DO NOTHING
    `);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "msg-id" }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "test@example.com" },
      });
      expect(res.statusCode).toBe(200);

      // Email was still sent despite suppression
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const reqBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
      expect(reqBody.to).toEqual(["test@example.com"]);

      await app.close();
    } finally {
      globalThis.fetch = originalFetch;
      // Clean up suppression
      await db.execute(sql`
        DELETE FROM suppressions WHERE tenant_id = ${testTenantId} AND email = 'test@example.com'
      `);
    }
  });
});

// ---------------------------------------------------------------------------
// Quickstart contract: no keys = login still reachable
// ---------------------------------------------------------------------------
// ENCRYPTION_KEY and UNSUBSCRIBE_SIGNING_KEY are absent in a fresh install.
// The server must still start and the login endpoint must respond successfully.
// This test verifies that contract: no keys set, login returns 200.
// (The console fallback path is used because no transport is configured.)

describe("login without ENCRYPTION_KEY or UNSUBSCRIBE_SIGNING_KEY", () => {
  it("POST /auth/login returns 200 when neither key is set (quickstart contract)", async () => {
    if (!dbAvailable) return;
    process.env.NODE_ENV = "test";

    const savedEncKey = process.env.ENCRYPTION_KEY;
    const savedSigningKey = process.env.UNSUBSCRIBE_SIGNING_KEY;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.UNSUBSCRIBE_SIGNING_KEY;

    try {
      // No transport configured in this state, so the login falls back to
      // the console path. In NODE_ENV=test that still returns 200 and logs
      // the URL to stdout rather than attempting email delivery.
      const app = await buildApp({ logger: false, db, baseUrl: "http://localhost:3000" });
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "test@example.com" },
      });
      // 200 - login is reachable even with no keys configured
      expect(res.statusCode).toBe(200);
      await app.close();
    } finally {
      if (savedEncKey !== undefined) process.env.ENCRYPTION_KEY = savedEncKey;
      else delete process.env.ENCRYPTION_KEY;
      if (savedSigningKey !== undefined) process.env.UNSUBSCRIBE_SIGNING_KEY = savedSigningKey;
      else delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// DASHBOARD_URL vs BASE_URL distinction
// ---------------------------------------------------------------------------
// These tests build the app with two clearly different origins:
//   baseUrl      = "http://api.example.com"  (API server, owns unsubscribe)
//   dashboardUrl = "http://dash.example.com" (SPA origin, owns auth redirects)
//
// They prove that:
//   1. The magic link URL (printed to console) uses the dashboardUrl origin.
//   2. POST /auth/verify success redirects to dashboardUrl.
//   3. GET /auth/verify failure redirects to dashboardUrl.
//
// The regression guard for BASE_URL semantics (assertion 4 - unsubscribe URL
// uses baseUrl) lives in packages/worker/tests/compliance.test.ts because
// buildComplianceOutput is defined in packages/worker/src/compliance.ts and
// already has a test file there.
//
// Each test is written so that reverting loginUrl to baseUrl (i.e. using
// baseUrl instead of dashboardUrl in the magic link construction) would cause
// it to fail.

describe("dashboardUrl vs baseUrl: magic link and verify redirect origins", () => {
  const TEST_BASE_URL = "http://api.example.com";
  const TEST_DASH_URL = "http://dash.example.com";

  it("POST /auth/login: console-printed link uses dashboardUrl origin, not baseUrl", async () => {
    if (!dbAvailable) return;
    process.env.NODE_ENV = "test";

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const app = await buildApp({
        logger: false,
        db,
        baseUrl: TEST_BASE_URL,
        dashboardUrl: TEST_DASH_URL,
      });

      await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "test@example.com" },
      });

      // The printed URL must start with dashboardUrl, not baseUrl.
      const printedLines = consoleSpy.mock.calls.flat().filter(
        (a): a is string => typeof a === "string",
      );
      const urlLine = printedLines.find((a) => a.includes("/auth/verify?token="));
      expect(urlLine).toBeDefined();
      // Fails if loginUrl is built from baseUrl ("http://api.example.com")
      expect(urlLine).toContain(TEST_DASH_URL);
      expect(urlLine).not.toContain(TEST_BASE_URL);

      await app.close();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("POST /auth/verify success: redirects to dashboardUrl/, not baseUrl/", async () => {
    if (!dbAvailable) return;

    const app = await buildApp({
      logger: false,
      db,
      baseUrl: TEST_BASE_URL,
      dashboardUrl: TEST_DASH_URL,
    });

    const rawToken = await createTestToken();
    const res = await postVerify(app, rawToken);

    expect(res.statusCode).toBe(302);
    // Fails if dashboardUrl is not used for the success redirect.
    expect(res.headers["location"]).toBe(`${TEST_DASH_URL}/`);
    expect(res.headers["location"]).not.toContain(TEST_BASE_URL);

    await app.close();
  });

  it("GET /auth/verify failure: redirects to dashboardUrl/login?error=invalid_link, not baseUrl", async () => {
    if (!dbAvailable) return;

    const app = await buildApp({
      logger: false,
      db,
      baseUrl: TEST_BASE_URL,
      dashboardUrl: TEST_DASH_URL,
    });

    const res = await app.inject({
      method: "GET",
      url: "/auth/verify?token=completely-fabricated-invalid-token",
    });

    expect(res.statusCode).toBe(302);
    // Fails if dashboardUrl is not used for the failure redirect.
    expect(res.headers["location"]).toBe(`${TEST_DASH_URL}/login?error=invalid_link`);
    expect(res.headers["location"]).not.toContain(TEST_BASE_URL);

    await app.close();
  });
});
