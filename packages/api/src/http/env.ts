/**
 * Shared Hono environment for the Claros HTTP API.
 *
 * Every route module receives the same context variables. `db` and `enqueue`
 * come from buildApp options; `tenant` is resolved from the session cookie on
 * every request (null when absent or invalid); `ingestTenant` is resolved from
 * an API key inside the ingestion scope; `body` is the request body as parsed
 * by the body middleware (see body.ts), mirroring the v0.6 parsing rules.
 */
import type { Context } from "hono";
import type { Db, EnqueueFn } from "../plugins/db.js";
import type { TenantContext } from "../types.js";
import type { IngestTenantContext } from "./ingest-auth.js";
import type { AppLogger } from "./logger.js";

export interface AppVariables {
  db: Db;
  enqueue: EnqueueFn | undefined;
  tenant: TenantContext | null;
  ingestTenant: IngestTenantContext | null;
  log: AppLogger;
  /** Parsed request body (JSON object, form fields, or raw text), undefined when none. */
  body: unknown;
}

export interface AppEnv {
  Variables: AppVariables;
}

export type AppContext = Context<AppEnv>;
