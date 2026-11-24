#!/usr/bin/env node
/**
 * Print every HTTP route the API registers, as sorted "METHOD /path" lines.
 *
 * The frozen v0.6 list lives in packages/api/tests/contract/v0.6-routes.txt.
 * Use this to compare the current app against it. Requires `npm run build`.
 * Routes are registered against a stub database; no connection is opened.
 */
import { buildApp } from "../packages/api/dist/index.js";

const stubDb = new Proxy({}, { get: () => () => stubDb });
const app = await buildApp({ db: stubDb, enqueue: async () => null, logger: false, serveDashboard: false, claimToken: "route-dump" });
process.stdout.write(app.routes().join("\n") + "\n");
await app.close();
