#!/usr/bin/env node
/**
 * Print every HTTP route the API registers, as sorted "METHOD /path" lines.
 *
 * Produces the v0.6 route-parity contract
 * (packages/api/tests/contract/v0.6-routes.txt). Requires `npm run build`.
 * Routes are registered against a stub database; no connection is opened.
 * Fastify has no public route list, so this parses printRoutes() output:
 * each tree line is a path segment appended to its parent's path.
 */
import { buildApp } from "../packages/api/dist/index.js";

const stubDb = new Proxy({}, { get: () => () => stubDb });
const app = await buildApp({ db: stubDb, enqueue: async () => {}, logger: false, serveDashboard: false, claimToken: "route-dump" });
await app.ready();

const lines = app.printRoutes({ commonPrefix: false }).split("\n").filter(Boolean);
const stack = [];
const out = new Set();
for (const line of lines) {
  const m = line.match(/^([│ ]*)(?:├── |└── )(.*?)(?: \(([A-Z, ]+)\))?$/u);
  if (!m) continue;
  const depth = m[1].length / 4;
  stack.length = depth;
  const path = (depth > 0 ? stack[depth - 1] : "") + m[2];
  stack[depth] = path;
  if (m[3]) {
    for (const method of m[3].split(",").map((s) => s.trim())) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      out.add(`${method} ${path}`);
    }
  }
}
process.stdout.write([...out].sort().join("\n") + "\n");
await app.close();
