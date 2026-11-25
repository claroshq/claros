/**
 * @claros/api - HTTP API layer (Hono routes and middleware), runtime-neutral.
 * The Node adapter (dashboard from disk, listen) is `@claros/api/node`.
 * Depends on @claros/core, @claros/adapters, @claros/db.
 */
export { buildApp, listRoutes } from "./app.js";
export type { BuildAppOptions, ClarosApp } from "./app.js";
export { API_PATH_PREFIXES, isApiPath, spaFallback } from "./http/spa.js";
export type { StaticFallback, StaticFiles } from "./http/spa.js";
export type { AppLogger } from "./http/logger.js";
export type { EnqueueFn } from "./plugins/db.js";
export type { TenantContext } from "./types.js";
export type { Db } from "./plugins/db.js";
export { SESSION_COOKIE_NAME } from "./http/session.js";
export { CLAIM_TOKEN_TTL_MS, hashClaimToken } from "./routes/claim.js";
export { hashApiKey, createIngestAuth, createIngestAuth as createIngestAuthPlugin } from "./http/ingest-auth.js";
export type { IngestTenantContext } from "./http/ingest-auth.js";
export type { InjectOptions, InjectResponse } from "./http/inject.js";
