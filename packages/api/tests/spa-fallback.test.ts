/**
 * Tests for the SPA fallback and static serving in buildApp.
 *
 * Tests use opts.serveDashboard=true with opts.dashboardDist set to a
 * temporary directory containing a minimal index.html. No real database is
 * needed: the fallback logic runs entirely in the not-found handler.
 *
 * Test cases:
 *   - GET / serves index.html
 *   - GET /some/deep/path serves index.html (SPA client routing)
 *   - GET /v1/unknown returns 404 JSON (API prefix, not SPA)
 *   - GET /auth/unknown returns 404 JSON (API prefix, not SPA)
 *   - GET /health does not serve index.html (already registered route)
 *   - POST /some/path does not serve index.html (wrong method)
 *   - auto resolution (no dashboardDist, no env var) finds real dist
 *   - warn-and-skip path logs exact path and mechanism
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp, resolvedDashboardDist } from "../src/app.js";

// ---------------------------------------------------------------------------
// Setup: minimal dist directory with index.html and an asset file.
// ---------------------------------------------------------------------------

const distDir = mkdtempSync(join(tmpdir(), "claros-spa-test-"));
writeFileSync(join(distDir, "index.html"), "<html><body>SPA</body></html>");
mkdirSync(join(distDir, "assets"));
writeFileSync(join(distDir, "assets", "main.abc123.js"), "console.log('spa');");

// Remove the temp directory after all suites finish, even if a test fails.
afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SPA fallback (serveDashboard=true)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      logger: false,
      serveDashboard: true,
      dashboardDist: distDir,
      dashboardUrl: "http://localhost:3000",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET / serves index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("SPA");
    // index.html must not be cached
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("GET /some/deep/path serves index.html (SPA client routing)", async () => {
    const res = await app.inject({ method: "GET", url: "/some/deep/path" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("SPA");
  });

  it("GET /login serves index.html (SPA login route owned by client)", async () => {
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("SPA");
  });

  it("GET /v1/unknown returns 404 JSON, not index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/unknown-route-xyz" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).not.toContain("SPA");
  });

  it("GET /auth/unknown returns 404 JSON, not index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/unknown-route-xyz" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).not.toContain("SPA");
  });

  it("GET /health returns the health response, not index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
  });

  it("POST to an unknown path returns 404 JSON, not index.html", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/some/unknown/path",
      payload: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).not.toContain("SPA");
  });

  it("GET /assets/main.abc123.js served with immutable cache header", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/main.abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/immutable/);
  });
});

describe("SPA serving disabled (serveDashboard=false)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      logger: false,
      serveDashboard: false,
      dashboardUrl: "http://localhost:3000",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET / returns 404 (no SPA fallback registered)", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
  });
});

describe("SPA serving skipped gracefully when dist directory is missing", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      logger: false,
      serveDashboard: true,
      dashboardDist: "/this/path/does/not/exist/at/all",
      dashboardUrl: "http://localhost:3000",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET / returns 404 (dist missing, SPA registration silently skipped)", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /health still works when dist is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// C1: Auto resolution (no dashboardDist, no env var)
//
// The test does NOT pass dashboardDist and does NOT set CLAROS_DASHBOARD_DIST.
// It verifies two things:
//
//   1. Path arithmetic: the auto branch must produce exactly
//      join(process.cwd(), "apps", "dashboard", "dist"). The process is always
//      started from the monorepo root (both locally and in CI). This assertion
//      fails immediately if the ".." count is wrong - it does not require the
//      directory to exist on disk, so it cannot be fooled by the test creating
//      a directory at a wrong-but-resolvable path.
//
//   2. Integration: buildApp with no dashboardDist/env var actually serves
//      index.html via GET /. Uses the real apps/dashboard/dist if it exists
//      (post-build), otherwise creates a minimal one and cleans up afterward.
//
// Why the path-arithmetic assertion bites on the wrong ".." count:
//   Broken (4 ".." from dirname): resolves one level ABOVE the monorepo root.
//   join(<parent-of-root>, "apps", "dashboard", "dist") != join(cwd(), ...).
//   The assertion fails before buildApp is called.
// ---------------------------------------------------------------------------

describe("Auto resolution (no dashboardDist, no env var) - C1", () => {
  let app: FastifyInstance;
  // Track whether we created the directory so we only remove what we created.
  let createdDist = false;
  // Expected path derived from this test file's own location - same layout
  // as app.ts, so the arithmetic must agree. This test file is at:
  //   packages/api/tests/spa-fallback.test.ts
  // dirname = packages/api/tests
  // Three ".." from dirname reaches the monorepo root:
  //   tests -> packages/api -> packages -> <root>
  // That is the same root app.ts reaches from packages/api/src.
  // Using import.meta.url here (not process.cwd) so the assertion is
  // correct regardless of which directory turbo runs the tests from.
  const testDir = dirname(fileURLToPath(import.meta.url));
  const expectedAutoPath = join(resolve(testDir, "../../.."), "apps", "dashboard", "dist");
  // The auto-resolved path from the app module location (no opts, no env).
  const { distPath: autoPath, mechanism } = resolvedDashboardDist({});

  beforeAll(async () => {
    // Guard: if CLAROS_DASHBOARD_DIST is set the env branch fires, not auto.
    // This would make the integration part of the test vacuous.
    if (mechanism !== "auto") {
      throw new Error(
        `Expected auto mechanism but got "${mechanism}". ` +
        "Is CLAROS_DASHBOARD_DIST set in the test environment? Unset it to exercise the auto branch.",
      );
    }

    // Core path-arithmetic assertion: must match before touching the filesystem.
    // If the ".." count in resolvedDashboardDist is wrong this throws here,
    // making the failure appear in beforeAll rather than a later test.
    // (The it() below also asserts it so the failure surfaces in the test report.)
    if (autoPath !== expectedAutoPath) {
      throw new Error(
        `Auto resolution produced the wrong path.\n` +
        `  expected: ${expectedAutoPath}\n` +
        `  got:      ${autoPath}\n` +
        "Fix the '..' count in resolvedDashboardDist.",
      );
    }

    if (!existsSync(autoPath)) {
      // Create a minimal dist directory at the auto-resolved path.
      mkdirSync(autoPath, { recursive: true });
      writeFileSync(join(autoPath, "index.html"), "<html><body>AUTO-SPA</body></html>");
      createdDist = true;
    } else if (!existsSync(join(autoPath, "index.html"))) {
      // The directory exists (e.g. from a partial build) but has no index.html.
      // Write one so the test has predictable content to assert on.
      writeFileSync(join(autoPath, "index.html"), "<html><body>AUTO-SPA</body></html>");
      createdDist = true;
    }
    // If the directory already contains index.html (full build), use it as-is.

    // Build the app with no dashboardDist and no env var.
    app = await buildApp({
      logger: false,
      serveDashboard: true,
      // dashboardDist intentionally absent - this is the branch under test
      dashboardUrl: "http://localhost:3000",
    });
  });

  afterAll(async () => {
    await app.close();
    if (createdDist) {
      // Remove only what we created.
      if (existsSync(join(autoPath, "assets"))) {
        // We added index.html to an existing dir - remove only the file.
        rmSync(join(autoPath, "index.html"), { force: true });
      } else {
        rmSync(autoPath, { recursive: true, force: true });
      }
    }
  });

  it("auto branch produces the correct path (3 '..' from dirname, not 4)", () => {
    // This assertion is the bite: if the ".." count is wrong, autoPath does not
    // equal expectedAutoPath and this test fails with the exact wrong value.
    expect(autoPath).toBe(expectedAutoPath);
  });

  it("GET / is served by auto-resolved dist (no dashboardDist or env var supplied)", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("GET /health still works when auto resolution is active", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// C2: Warn-and-skip path logs the exact path and mechanism
//
// Uses a custom Fastify logger that captures warn calls. Builds the app with
// serveDashboard=true and a dashboardDist that does not exist. Asserts that
// the captured warning includes the exact path tried and the mechanism name.
// Also asserts that API routes still work after the skip.
// ---------------------------------------------------------------------------

describe("Warn-and-skip logs specific path and mechanism - C2", () => {
  let app: FastifyInstance;
  const warnMessages: string[] = [];
  const missingPath = "/this/path/does/not/exist/at/all";

  beforeAll(async () => {
    // Custom logger: capture warn calls, silence everything else.
    const logger = {
      level: "warn",
      warn: (msg: string | object) => {
        warnMessages.push(typeof msg === "string" ? msg : JSON.stringify(msg));
      },
      // Required by Fastify's logger interface; no-op for this test.
      info: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      child: () => logger,
      silent: () => {},
    };

    app = await buildApp({
      logger: logger as unknown as import("fastify").FastifyServerOptions["logger"],
      serveDashboard: true,
      dashboardDist: missingPath,
      dashboardUrl: "http://localhost:3000",
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("warning message contains the exact path that was tried", () => {
    const combined = warnMessages.join("\n");
    expect(combined).toContain(missingPath);
  });

  it("warning message contains the mechanism name (opts)", () => {
    // dashboardDist was supplied via opts, so mechanism=opts.
    const combined = warnMessages.join("\n");
    expect(combined).toContain("mechanism=opts");
  });

  it("warning message contains tried= so path is unambiguous", () => {
    const combined = warnMessages.join("\n");
    expect(combined).toContain(`tried=${missingPath}`);
  });

  it("GET /health still works after the warn-and-skip", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("GET / returns Fastify default 404 (SPA handler not registered)", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
  });
});
