/**
 * Bearer token authentication plugin for event ingestion.
 *
 * Resolves tenant from the API key in the Authorization header, or - for the
 * browser beacon path only - from a `key` field in the JSON request body.
 * The body path exists because an Authorization header forces a CORS
 * preflight on every browser request and cannot be set by
 * navigator.sendBeacon at all; a body-carried publishable key with a
 * text/plain content type is a CORS-simple request. Body-carried keys must
 * be publishable kind; a secret key in a body is rejected, because a secret
 * key has no legitimate reason to travel through a browser-shaped request.
 *
 * Security model: we store only the SHA-256 hash of each key. On each request
 * we hash the incoming bearer value and look it up via DB equality. Timing
 * attacks are not a concern here because:
 * - The comparison is on hash outputs, not raw secrets.
 * - An attacker cannot control which byte of the hash differs (changing one
 *   character of the input produces an entirely unrelated SHA-256 output).
 * - Exploiting a timing side-channel on hash comparison would require finding
 *   preimages that produce hashes differing at progressively later bytes,
 *   which is computationally equivalent to brute-forcing SHA-256.
 *
 * Therefore the DB's built-in equality check on key_hash is sufficient.
 * No application-level timingSafeEqual is needed or used.
 *
 * Key kinds (api_keys.kind):
 * - publishable: safe to embed in a web page. Write-only capability (there is
 *   no key-authenticated read endpoint at all). May carry an origin allowlist
 *   (api_keys.allowed_origins); requests with an Origin header not in the
 *   list are rejected with 403. Requests without an Origin header are not
 *   origin-checked (curl, server-side); the allowlist is browser-enforced
 *   abuse friction, not a trust boundary.
 * - secret: server-side. No origin check. The CORS layer never echoes an
 *   Origin for secret keys, so a browser cannot read responses cross-origin.
 *
 * Rate limiting: fixed one-minute window per key, in-memory per process.
 * Publishable keys: 300 req/min (a page firing 5 events/sec has headroom).
 * Secret keys: 3000 req/min (50/s sustained; the whole-system design target
 * in docs/MARKET_AND_INGESTION.md B6 is ~100-115/s across all tenants).
 * Multi-replica deployments get per-replica windows; Cloud enforcement lives
 * in the ingress Worker (M&I B4), this limiter protects the community
 * single-container default. 429 responses carry Retry-After.
 *
 * This plugin is registered on the ingestion scope ONLY. It does NOT share
 * any auth logic with the session-cookie tenant plugin used by the dashboard.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { eq, isNull, and } from "drizzle-orm";
import { apiKeys } from "@claros/db/schema";
import type { Db } from "./db.js";

export type ApiKeyKind = "publishable" | "secret";

export interface IngestTenantContext {
  id: string;
  apiKeyId: string;
  kind: ApiKeyKind;
  /**
   * The Origin the CORS layer may echo back for this request, or null when
   * no Access-Control-Allow-Origin header should be emitted (no Origin on
   * the request, or a secret key, whose browser use we deliberately do not
   * bless). Set by the auth hook; consumed by the onSend hook in
   * ingest-cors.ts.
   */
  corsOrigin: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    ingestTenant: IngestTenantContext | null;
  }
}

/** Per-minute request ceilings by key kind. See file header for rationale. */
export const RATE_LIMITS: Record<ApiKeyKind, number> = {
  publishable: 300,
  secret: 3000,
};

const WINDOW_MS = 60_000;
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Hash a raw API key to its storage form (SHA-256 hex).
 * Exported for use in key generation utilities.
 */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Extract the raw key from the request:
 * 1. `Authorization: Bearer <key>` - primary, documented everywhere.
 * 2. `Authorization: Basic <base64(key:)>` - Segment HTTP API convention
 *    (write key as the Basic auth username, empty password). This is what
 *    Segment-compatible SDKs send when pointed at our endpoint.
 * 3. A top-level `key` string field in an already-parsed JSON body -
 *    browser beacon path, publishable keys only (enforced by the caller).
 */
function extractRawKey(request: FastifyRequest): { raw: string; from: "header" | "body" } | null {
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ") && authHeader.length > 7) {
    return { raw: authHeader.slice(7), from: "header" };
  }
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const username = decoded.split(":")[0] ?? "";
      if (username.length > 0) {
        return { raw: username, from: "header" };
      }
    } catch {
      // malformed base64 falls through to 401
    }
  }
  const body = request.body as Record<string, unknown> | null | undefined;
  if (body && typeof body.key === "string" && body.key.length > 0) {
    return { raw: body.key, from: "body" };
  }
  return null;
}

interface RateBucket {
  windowStartMs: number;
  count: number;
}

function makeIngestAuthRegistrar(lastUsedThrottleMs: number) {
  return function register(app: FastifyInstance): void {
    app.decorateRequest("ingestTenant", null as IngestTenantContext | null);

    // Throttle last_used_at writes: at most once per 60 seconds per key.
    // Ingestion is the hot path - writing the same row on every request
    // produces dead-tuple accumulation for no informational gain.
    // The column answers "is this key in use," and a per-minute write
    // answers that question just as well.
    const lastWrittenAt = new Map<string, number>();

    // Fixed-window rate limiter state, keyed by api_keys.id.
    const buckets = new Map<string, RateBucket>();

    app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
      // Preflight requests carry no credentials; the CORS plugin answers them.
      // Enforcement happens on the actual request.
      if (request.method === "OPTIONS") {
        return;
      }

      const extracted = extractRawKey(request);
      if (!extracted) {
        reply.status(401);
        return reply.send({ error: "Missing or invalid Authorization header." });
      }

      const db: Db = request.server.db;
      if (!db) {
        reply.status(500);
        return reply.send({ error: "Database unavailable." });
      }

      // Hash the incoming key
      const incomingHash = hashApiKey(extracted.raw);

      // Look up active keys matching this hash.
      // The partial unique index (uq_api_keys_hash_active) makes this fast.
      const rows = await db
        .select({
          id: apiKeys.id,
          tenantId: apiKeys.tenantId,
          kind: apiKeys.kind,
          allowedOrigins: apiKeys.allowedOrigins,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, incomingHash), isNull(apiKeys.revokedAt)))
        .limit(1);

      if (rows.length === 0) {
        reply.status(401);
        return reply.send({ error: "Invalid or revoked API key." });
      }

      const row = rows[0]!;
      const kind: ApiKeyKind = row.kind === "publishable" ? "publishable" : "secret";

      // A body-carried key has traveled through a browser-shaped request.
      // Only publishable keys are allowed there.
      if (extracted.from === "body" && kind !== "publishable") {
        reply.status(401);
        return reply.send({ error: "This key cannot be used from a browser." });
      }

      // Origin handling. Requests without an Origin header are not browsers;
      // no CORS headers are emitted for them in either direction.
      const origin = request.headers.origin ?? null;
      let corsOrigin: string | null = null;
      if (origin !== null && kind === "publishable") {
        const allowlist = Array.isArray(row.allowedOrigins) ? row.allowedOrigins : [];
        if (allowlist.length > 0 && !allowlist.includes(origin)) {
          // No CORS headers on this response: the browser blocks it outright.
          reply.status(403);
          return reply.send({ error: "Origin not allowed for this key." });
        }
        corsOrigin = origin;
      }

      // Fixed-window rate limit, per key.
      const now = Date.now();
      const bucket = buckets.get(row.id);
      if (!bucket || now - bucket.windowStartMs >= WINDOW_MS) {
        buckets.set(row.id, { windowStartMs: now, count: 1 });
      } else {
        bucket.count += 1;
        if (bucket.count > RATE_LIMITS[kind]) {
          const retryAfterSec = Math.ceil((bucket.windowStartMs + WINDOW_MS - now) / 1000);
          reply.status(429);
          reply.header("Retry-After", String(retryAfterSec));
          if (corsOrigin) {
            // Let the browser read the 429 and Retry-After.
            reply.header("Access-Control-Allow-Origin", corsOrigin);
            reply.header("Vary", "Origin");
          }
          return reply.send({ error: "Rate limit exceeded." });
        }
      }

      request.ingestTenant = {
        id: row.tenantId,
        apiKeyId: row.id,
        kind,
        corsOrigin,
      };

      // Fire-and-forget: update last_used_at, throttled to once per 60s per key.
      const lastWrite = lastWrittenAt.get(row.id) ?? 0;
      if (now - lastWrite >= lastUsedThrottleMs) {
        lastWrittenAt.set(row.id, now);
        db.update(apiKeys)
          .set({ lastUsedAt: new Date(now) })
          .where(eq(apiKeys.id, row.id))
          .then(() => {})
          .catch(() => {
            // On failure, clear the cache entry so the next request retries
            lastWrittenAt.delete(row.id);
          });
      }
    });
  };
}

/**
 * Register bearer-token authentication on an encapsulated Fastify scope.
 *
 * Every request in this scope must carry `Authorization: Bearer <write_key>`
 * or a body `key` field. The key is hashed and looked up in api_keys WHERE
 * revoked_at IS NULL. On success, request.ingestTenant is set. On failure,
 * 401 is returned. OPTIONS (preflight) requests pass through untouched -
 * they carry no credentials by definition and are answered by the CORS
 * plugin; enforcement happens on the actual request.
 */
export const registerIngestAuthPlugin: (app: FastifyInstance) => void =
  makeIngestAuthRegistrar(LAST_USED_THROTTLE_MS);

/**
 * Exposed for testing only: allows tests to override the last_used_at
 * throttle interval. In production this is not called.
 */
export function createIngestAuthPlugin(throttleMs: number) {
  return makeIngestAuthRegistrar(throttleMs);
}
