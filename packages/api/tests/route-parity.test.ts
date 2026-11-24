/**
 * Route parity with the v0.6 HTTP API.
 *
 * tests/contract/v0.6-routes.txt is the frozen list of every route v0.6.4
 * served. Claros keeps the HTTP API backward compatible, so every route in
 * that file must still be registered. New routes are allowed; a missing one
 * fails this test. Regenerate the contract only for a deliberate, documented
 * removal (CHANGELOG entry plus a deprecation in an earlier release).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { listRoutes } from "./contract/list-routes.js";

const here = dirname(fileURLToPath(import.meta.url));
const contract = readFileSync(join(here, "contract", "v0.6-routes.txt"), "utf-8")
  .split("\n")
  .filter(Boolean);

describe("route parity with v0.6", () => {
  it("registers every v0.6 route", async () => {
    const stubDb = new Proxy({}, { get: () => () => stubDb }) as never;
    const app = await buildApp({
      db: stubDb,
      enqueue: async () => {},
      logger: false,
      serveDashboard: false,
      claimToken: "route-parity",
    });
    await app.ready();
    const current = new Set(listRoutes(app.printRoutes({ commonPrefix: false })));
    await app.close();

    const missing = contract.filter((route) => !current.has(route));
    expect(missing).toEqual([]);
  });
});
