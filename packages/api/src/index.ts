/**
 * @claros/api - HTTP API layer (Fastify routes, plugins, middleware).
 * Depends on @claros/core, @claros/adapters, @claros/db.
 */
export { buildApp } from "./app.js";
export type { BuildAppOptions } from "./app.js";
export type { TenantContext } from "./types.js";
export type { Db } from "./plugins/db.js";
export { SESSION_COOKIE_NAME } from "./routes/auth.js";
export { hashApiKey, createIngestAuthPlugin } from "./plugins/ingest-auth.js";
export type { IngestTenantContext } from "./plugins/ingest-auth.js";
