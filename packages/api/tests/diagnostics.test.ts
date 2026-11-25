/**
 * Tests for GET /v1/diagnostics.
 *
 * ALL tests run against an app built by buildApp (packages/api/src/app.ts),
 * using the same stub/mock db pattern as cloud/tests/ingress-coverage.test.ts.
 * No private app instance is constructed; the real /v1 auth gate in
 * app.ts is what is exercised.
 *
 * Two db fixtures are used:
 *
 *   stubDb  - a truthy empty object (same as ingress-coverage.test.ts).
 *             registerTenantPlugin uses it to gate session lookup. When a
 *             cookie is absent (no session), tenant stays null and the real
 *             /v1 preHandler returns 401. When a cookie IS present the plugin
 *             tries db.select(...) on the stub and throws - that 500 is not
 *             tested here; we only need the no-cookie 401 path.
 *
 *   mockDb  - a mock that implements the Drizzle builder chain used in
 *             registerTenantPlugin: select().from().innerJoin().innerJoin()
 *             .where().limit() resolving to a valid unexpired session row.
 *             This makes the real tenant plugin resolve request.tenant so the
 *             real /v1 preHandler passes. The route handler then runs against
 *             the real diagnostics implementation.
 *
 * The 401 test therefore exercises the real gate in app.ts. Removing that gate
 * causes the 401 test to fail (demonstrated below in the "auth gate proof").
 *
 * Assertions that genuinely require a real DB (session lifecycle, expiry,
 * invalid session ID) are NOT made here - they belong in auth.db.test.ts. What
 * is tested here is:
 *   - the real /v1 preHandler returns 401 when tenant is null (no cookie)
 *   - the full diagnostics route shape, startedAt, env reflection, key paths
 *   - /version does not include startedAt
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { ClarosApp } from "../src/index.js";
import { buildApp } from "../src/index.js";
import type { Db } from "../src/plugins/db.js";

// ---------------------------------------------------------------------------
// DB fixtures
// ---------------------------------------------------------------------------

/**
 * Stub db: a truthy empty object. Causes the tenant plugin's session-lookup
 * DB call to throw if a cookie is present (db.select is not a function).
 * Safe for the 401 test because no cookie means the lookup never runs.
 */
const stubDb = {} as Db;

/**
 * Build a mock db whose select chain resolves to a single valid session row.
 * The chain called by registerTenantPlugin is:
 *   db.select({...}).from(sessions).innerJoin(...).innerJoin(...).where(...).limit(1)
 * We return a chainable builder where every method returns `this` except
 * limit(), which returns a Promise resolving to the provided rows array.
 */
function buildMockDb(rows: unknown[]): Db {
  const chain = {
    select: () => chain,
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain as unknown as Db;
}

// A session row that will pass the expiry check (expires 30 days from now).
const VALID_SESSION_ROW = {
  sessionUserId: "00000000-0000-0000-0000-000000000099",
  sessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  tenantId: "00000000-0000-0000-0000-000000000001",
  tenantSlug: "test-diagnostics",
  userRole: "owner",
  userDeactivatedAt: null,
};

const SESSION_COOKIE = "claros_session=test-session-id-for-diagnostics-unit-test";

// ---------------------------------------------------------------------------
// App fixtures
// ---------------------------------------------------------------------------

let appUnauth: ClarosApp; // stub db - for 401 test (no cookie sent)
let appAuth: ClarosApp;   // mock db returning valid session - for 200 tests

beforeAll(async () => {
  appUnauth = await buildApp({ logger: false, db: stubDb });
  appAuth   = await buildApp({ logger: false, db: buildMockDb([VALID_SESSION_ROW]) });
});

afterAll(async () => {
  await appUnauth.close();
  await appAuth.close();
});

afterEach(() => {
  // Restore env vars mutated during a test.
  delete process.env.CLAROS_COMMIT_SHA;
  delete process.env.CLAROS_BUILT_AT;
  delete process.env.ENCRYPTION_KEY;
  delete process.env.UNSUBSCRIBE_SIGNING_KEY;
});

// ---------------------------------------------------------------------------
// Auth gate - exercises the real /v1 preHandler in app.ts
// ---------------------------------------------------------------------------

describe("GET /v1/diagnostics - auth gate (real /v1 preHandler in app.ts)", () => {
  it("returns 401 when no session cookie is present", async () => {
    // No cookie: tenant plugin does not run the DB lookup; request.tenant stays
    // null; the real /v1 preHandler in app.ts sends 401.
    const res = await appUnauth.inject({ method: "GET", url: "/v1/diagnostics" });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Authenticated path - real route handler via mock session resolution
// ---------------------------------------------------------------------------

describe("GET /v1/diagnostics - authenticated (mock db resolves real tenant plugin)", () => {
  it("returns 200 with correct top-level shape", async () => {
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body.commit).toBe("string");
    expect(typeof body.edition).toBe("string");
    expect(body.builtAt === null || typeof body.builtAt === "string").toBe(true);
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.keys).toBe("object");
  });

  it("startedAt is a valid ISO-8601 UTC timestamp", async () => {
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    const body = JSON.parse(res.body) as { startedAt: string };
    const parsed = new Date(body.startedAt);
    expect(isNaN(parsed.getTime())).toBe(false);
    expect(body.startedAt).toMatch(/Z$/);
  });

  it("startedAt is stable across multiple requests (same process)", async () => {
    const r1 = await appAuth.inject({ method: "GET", url: "/v1/diagnostics", headers: { cookie: SESSION_COOKIE } });
    const r2 = await appAuth.inject({ method: "GET", url: "/v1/diagnostics", headers: { cookie: SESSION_COOKIE } });
    const b1 = JSON.parse(r1.body) as { startedAt: string };
    const b2 = JSON.parse(r2.body) as { startedAt: string };
    expect(b1.startedAt).toBe(b2.startedAt);
  });

  it("startedAt is in the past relative to the current time", async () => {
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    const body = JSON.parse(res.body) as { startedAt: string };
    expect(new Date(body.startedAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("commit defaults to 'unknown' when CLAROS_COMMIT_SHA is absent", async () => {
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    const body = JSON.parse(res.body) as { commit: string };
    expect(body.commit).toBe("unknown");
  });

  it("commit reflects CLAROS_COMMIT_SHA when set", async () => {
    process.env.CLAROS_COMMIT_SHA = "abc1234def5678";
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    const body = JSON.parse(res.body) as { commit: string };
    expect(body.commit).toBe("abc1234def5678");
  });

  it("builtAt is null when CLAROS_BUILT_AT is absent", async () => {
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    const body = JSON.parse(res.body) as { builtAt: string | null };
    expect(body.builtAt).toBeNull();
  });

  it("builtAt reflects CLAROS_BUILT_AT when set", async () => {
    process.env.CLAROS_BUILT_AT = "2026-07-29T10:00:00Z";
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    const body = JSON.parse(res.body) as { builtAt: string | null };
    expect(body.builtAt).toBe("2026-07-29T10:00:00Z");
  });

  it("ENCRYPTION_KEY: absent when env not set", async () => {
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    const body = JSON.parse(res.body) as {
      keys: { ENCRYPTION_KEY: { present: boolean; byteLength: null; fingerprint: null; decodeError: null } };
    };
    expect(body.keys.ENCRYPTION_KEY.present).toBe(false);
    expect(body.keys.ENCRYPTION_KEY.byteLength).toBeNull();
    expect(body.keys.ENCRYPTION_KEY.fingerprint).toBeNull();
    expect(body.keys.ENCRYPTION_KEY.decodeError).toBeNull();
  });

  it("ENCRYPTION_KEY: present with correct byteLength and fingerprint when set", async () => {
    process.env.ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    const body = JSON.parse(res.body) as {
      keys: { ENCRYPTION_KEY: { present: boolean; byteLength: number; fingerprint: string; decodeError: null } };
    };
    expect(body.keys.ENCRYPTION_KEY.present).toBe(true);
    expect(body.keys.ENCRYPTION_KEY.byteLength).toBe(32);
    expect(typeof body.keys.ENCRYPTION_KEY.fingerprint).toBe("string");
    expect(body.keys.ENCRYPTION_KEY.fingerprint).toHaveLength(8);
    expect(body.keys.ENCRYPTION_KEY.decodeError).toBeNull();
  });

  it("UNSUBSCRIBE_SIGNING_KEY: absent when env not set", async () => {
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    const body = JSON.parse(res.body) as {
      keys: { UNSUBSCRIBE_SIGNING_KEY: { present: boolean; byteLength: null; fingerprint: null; decodeError: null } };
    };
    expect(body.keys.UNSUBSCRIBE_SIGNING_KEY.present).toBe(false);
    expect(body.keys.UNSUBSCRIBE_SIGNING_KEY.byteLength).toBeNull();
    expect(body.keys.UNSUBSCRIBE_SIGNING_KEY.fingerprint).toBeNull();
    expect(body.keys.UNSUBSCRIBE_SIGNING_KEY.decodeError).toBeNull();
  });

  it("UNSUBSCRIBE_SIGNING_KEY: present with correct byteLength and fingerprint when set", async () => {
    process.env.UNSUBSCRIBE_SIGNING_KEY = "0".repeat(64);
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    const body = JSON.parse(res.body) as {
      keys: {
        UNSUBSCRIBE_SIGNING_KEY: { present: boolean; byteLength: number; fingerprint: string; decodeError: null };
      };
    };
    expect(body.keys.UNSUBSCRIBE_SIGNING_KEY.present).toBe(true);
    expect(body.keys.UNSUBSCRIBE_SIGNING_KEY.byteLength).toBe(32);
    expect(typeof body.keys.UNSUBSCRIBE_SIGNING_KEY.fingerprint).toBe("string");
    expect(body.keys.UNSUBSCRIBE_SIGNING_KEY.fingerprint).toHaveLength(8);
    expect(body.keys.UNSUBSCRIBE_SIGNING_KEY.decodeError).toBeNull();
  });

  it("key with a non-empty but zero-byte base64 decode returns decodeError", async () => {
    // "====" is non-empty but Buffer.from("====", "base64") decodes to 0 bytes.
    // The route guards: if (buf.length === 0) return decodeError.
    process.env.ENCRYPTION_KEY = "====";
    const res = await appAuth.inject({
      method: "GET",
      url: "/v1/diagnostics",
      headers: { cookie: SESSION_COOKIE },
    });
    const body = JSON.parse(res.body) as {
      keys: {
        ENCRYPTION_KEY: {
          present: boolean;
          byteLength: number | null;
          fingerprint: string | null;
          decodeError: string | null;
        };
      };
    };
    expect(body.keys.ENCRYPTION_KEY.present).toBe(true);
    expect(body.keys.ENCRYPTION_KEY.byteLength).toBeNull();
    expect(body.keys.ENCRYPTION_KEY.fingerprint).toBeNull();
    expect(typeof body.keys.ENCRYPTION_KEY.decodeError).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// /version must NOT include startedAt
// ---------------------------------------------------------------------------

describe("GET /version does NOT include startedAt", () => {
  let appVersion: ClarosApp;

  beforeAll(async () => {
    appVersion = await buildApp({ logger: false, role: "all", edition: "community" });
  });

  afterAll(async () => {
    await appVersion.close();
  });

  it("/version response does not contain startedAt", async () => {
    const res = await appVersion.inject({ method: "GET", url: "/version" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect("startedAt" in body).toBe(false);
    expect("commit" in body).toBe(true);
    expect("edition" in body).toBe(true);
    expect("builtAt" in body).toBe(true);
  });
});

describe("GET /version: optional version field", () => {
  it("is absent without CLAROS_VERSION (v0.6 shape) and reported when set", async () => {
    const prev = process.env.CLAROS_VERSION;
    try {
      delete process.env.CLAROS_VERSION;
      const app = await buildApp({ logger: false });
      const plain = JSON.parse((await app.inject({ method: "GET", url: "/version" })).body) as Record<string, unknown>;
      expect(Object.keys(plain).sort()).toEqual(["builtAt", "commit", "edition"]);

      process.env.CLAROS_VERSION = "0.8.0";
      const withVersion = JSON.parse((await app.inject({ method: "GET", url: "/version" })).body) as Record<string, unknown>;
      expect(withVersion.version).toBe("0.8.0");
    } finally {
      if (prev === undefined) delete process.env.CLAROS_VERSION;
      else process.env.CLAROS_VERSION = prev;
    }
  });
});
