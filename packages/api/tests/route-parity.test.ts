/**
 * Route parity with the v0.6 HTTP API.
 *
 * tests/contract/v0.6-routes.txt is the frozen list of every route v0.6.4
 * served. Claros keeps the HTTP API backward compatible, so every route in
 * that file must still be registered. New routes are allowed; a missing one
 * fails this test. Regenerate the contract only for a deliberate, documented
 * removal (CHANGELOG entry plus a deprecation in an earlier release).
 *
 * v0.6 listed "/prefix" and "/prefix/" separately; the app is non-strict
 * about trailing slashes (both are served), so they compare as one route.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const normalize = (route: string) => (route.length > 1 ? route.replace(/\/$/, "") : route);
const contract = [
  ...new Set(
    readFileSync(join(here, "contract", "v0.6-routes.txt"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map(normalize),
  ),
];

describe("route parity with v0.6", () => {
  it("registers every v0.6 route", async () => {
    const stubDb = new Proxy({}, { get: () => () => stubDb }) as never;
    const app = await buildApp({
      db: stubDb,
      enqueue: async () => null,
      logger: false,
      serveDashboard: false,
      claimToken: "route-parity",
    });
    const current = new Set(app.routes().map(normalize));
    await app.close();

    const missing = contract.filter((route) => !current.has(route));
    expect(missing).toEqual([]);
  });

  it("answers both /prefix and /prefix/ like v0.6", async () => {
    const app = await buildApp({ logger: false });
    const a = await app.inject({ method: "GET", url: "/health" });
    const b = await app.inject({ method: "GET", url: "/health/" });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });
});
