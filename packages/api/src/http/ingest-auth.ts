/**
 * API key authentication and CORS for the ingestion routes
 * (POST /v1/track, /v1/identify, /v1/batch).
 *
 * Behaviour is unchanged from v0.6:
 *
 * Keys: `Authorization: Bearer <key>`, `Authorization: Basic base64(key:)`
 * (Segment convention), or a top-level `key` field in the JSON body (browser
 * beacon path, publishable keys only). Only the SHA-256 hash of a key is
 * stored; lookup is by hash equality, so no timing-safe compare is needed.
 *
 * Kinds: publishable keys may carry an origin allowlist (403 for a browser
 * Origin not on it); secret keys never get CORS headers, so a browser cannot
 * read their responses cross-origin.
 *
 * Rate limit: fixed one-minute window per key, in memory per process
 * (publishable 300/min, secret 3000/min); 429 with Retry-After.
 *
 * last_used_at: written at most once per minute per key, fire-and-forget.
 *
 * CORS: OPTIONS preflights are answered permissively (they carry no key);
 * actual responses echo the Origin only when the auth step approved it.
 * The browser snippet posts JSON as text/plain (a CORS-simple request), so
 * this scope parses text/plain as JSON.
 */
import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { eq, isNull, and } from "drizzle-orm";
import { apiKeys } from "@claros/db/schema";
import type { AppEnv } from "./env.js";

export type ApiKeyKind = "publishable" | "secret";

export interface IngestTenantContext {
  id: string;
  apiKeyId: string;
  kind: ApiKeyKind;
  /** Origin the response may echo in Access-Control-Allow-Origin, or null. */
  corsOrigin: string | null;
}

/** Per-minute request ceilings by key kind. */
export const RATE_LIMITS: Record<ApiKeyKind, number> = {
  publishable: 300,
  secret: 3000,
};

const WINDOW_MS = 60_000;
const LAST_USED_THROTTLE_MS = 60_000;

/** Hash a raw API key to its storage form (SHA-256 hex). */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** text/plain in the ingestion scope is JSON sent by the browser snippet. */
export function parsePlainTextAsJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function extractRawKey(c: Context<AppEnv>): { raw: string; from: "header" | "body" } | null {
  const authHeader = c.req.header("authorization");
  if (authHeader && authHeader.startsWith("Bearer ") && authHeader.length > 7) {
    return { raw: authHeader.slice(7), from: "header" };
  }
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const username = decoded.split(":")[0] ?? "";
      if (username.length > 0) return { raw: username, from: "header" };
    } catch {
      // malformed base64 falls through to 401
    }
  }
  const body = c.var.body as Record<string, unknown> | null | undefined;
  if (body && typeof body === "object" && typeof body.key === "string" && body.key.length > 0) {
    return { raw: body.key, from: "body" };
  }
  return null;
}

interface RateBucket {
  windowStartMs: number;
  count: number;
}

/**
 * Create the ingestion auth middleware. Each call has its own rate-limit and
 * last_used_at state (one per app instance, as in v0.6).
 */
export function createIngestAuth(lastUsedThrottleMs: number = LAST_USED_THROTTLE_MS): MiddlewareHandler<AppEnv> {
  const lastWrittenAt = new Map<string, number>();
  const buckets = new Map<string, RateBucket>();

  return async (c, next) => {
    c.set("ingestTenant", null);

    const extracted = extractRawKey(c);
    if (!extracted) {
      return c.json({ error: "Missing or invalid Authorization header." }, 401);
    }

    const db = c.var.db;
    if (!db) {
      return c.json({ error: "Database unavailable." }, 500);
    }

    const rows = await db
      .select({
        id: apiKeys.id,
        tenantId: apiKeys.tenantId,
        kind: apiKeys.kind,
        allowedOrigins: apiKeys.allowedOrigins,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hashApiKey(extracted.raw)), isNull(apiKeys.revokedAt)))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "Invalid or revoked API key." }, 401);
    }

    const row = rows[0]!;
    const kind: ApiKeyKind = row.kind === "publishable" ? "publishable" : "secret";

    if (extracted.from === "body" && kind !== "publishable") {
      return c.json({ error: "This key cannot be used from a browser." }, 401);
    }

    const origin = c.req.header("origin") ?? null;
    let corsOrigin: string | null = null;
    if (origin !== null && kind === "publishable") {
      const allowlist = Array.isArray(row.allowedOrigins) ? row.allowedOrigins : [];
      if (allowlist.length > 0 && !allowlist.includes(origin)) {
        return c.json({ error: "Origin not allowed for this key." }, 403);
      }
      corsOrigin = origin;
    }

    const now = Date.now();
    const bucket = buckets.get(row.id);
    if (!bucket || now - bucket.windowStartMs >= WINDOW_MS) {
      buckets.set(row.id, { windowStartMs: now, count: 1 });
    } else {
      bucket.count += 1;
      if (bucket.count > RATE_LIMITS[kind]) {
        const retryAfterSec = Math.ceil((bucket.windowStartMs + WINDOW_MS - now) / 1000);
        c.header("Retry-After", String(retryAfterSec));
        if (corsOrigin) {
          c.header("Access-Control-Allow-Origin", corsOrigin);
          c.header("Vary", "Origin");
        }
        return c.json({ error: "Rate limit exceeded." }, 429);
      }
    }

    c.set("ingestTenant", { id: row.tenantId, apiKeyId: row.id, kind, corsOrigin });

    const lastWrite = lastWrittenAt.get(row.id) ?? 0;
    if (now - lastWrite >= lastUsedThrottleMs) {
      lastWrittenAt.set(row.id, now);
      db.update(apiKeys)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(apiKeys.id, row.id))
        .then(() => {})
        .catch(() => {
          lastWrittenAt.delete(row.id);
        });
    }

    await next();

    // Echo the approved Origin on the actual response.
    if (corsOrigin && !c.res.headers.has("Access-Control-Allow-Origin")) {
      c.res.headers.set("Access-Control-Allow-Origin", corsOrigin);
      c.res.headers.set("Vary", "Origin");
    }
  };
}

/** OPTIONS preflight for the ingestion routes. */
export function ingestPreflight(c: Context<AppEnv>): Response {
  const origin = c.req.header("origin");
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "authorization, content-type");
  c.header("Access-Control-Max-Age", "86400");
  return c.body(null, 204);
}
