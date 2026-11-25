/**
 * Ingestion management routes (dashboard operator scope, session cookie auth).
 *
 * Endpoints:
 *   GET  /v1/ingestion/keys            list API keys (never returns raw keys)
 *   POST /v1/ingestion/keys            create a key; raw value returned ONCE
 *   PATCH /v1/ingestion/keys/:id       update label / allowed_origins
 *   POST /v1/ingestion/keys/:id/revoke revoke a key (idempotent)
 *   GET  /v1/ingestion/status          last received event + 24h count
 *
 * Key kinds:
 *   publishable - browser-embeddable, write-only, optional origin allowlist,
 *                 stricter rate limit. Prefix clr_pk_.
 *   secret      - server-side ingestion. Prefix clr_sk_.
 *   admin       - management API key of the product (G1), with scopes.
 *                 Prefix clr_ak_. Owner only (create, update, revoke).
 *
 * An instance key with the keys:write scope (item 11) may list the
 * product's keys and create, update and revoke its admin keys; the product
 * is the one named by X-Claros-Product or ?product=.
 * Keys created before the clr_ prefixes (cl_pub_, cl_live_) keep working.
 *
 * Only the SHA-256 hash of a key is stored. The raw value is returned by
 * POST once and is unrecoverable afterwards; the prefix column supports
 * masked display (clr_pk_a...).
 *
 * GET /v1/ingestion/status powers the "waiting for your first event"
 * indicator on the Integrate screen. Events queries are bounded to recent
 * partitions (received_at >= now - 7 days) because events is partitioned by
 * received_at and an unbounded ORDER BY received_at DESC would scan every
 * partition.
 */
import { createHash, randomBytes } from "node:crypto";
import { RoleRouter, allowInstanceKey } from "../http/router.js";
import type { AppContext } from "../http/env.js";
import { z } from "zod";
import { storeFor } from "@claros/store";
import type { Db } from "../plugins/db.js";
import { ADMIN_SCOPES, KEY_PREFIX } from "../http/admin-auth.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const KEY_KINDS = ["publishable", "secret", "admin"] as const;

const scopesSchema = z.array(z.enum(ADMIN_SCOPES)).min(1).max(ADMIN_SCOPES.length);

/**
 * An origin entry must be a bare origin: scheme + host + optional port,
 * no path, query, or trailing slash. new URL(s).origin === s captures this
 * and normalizes nothing else (lowercase host is fine either way since the
 * browser's Origin header is already normalized the same way).
 */
const originSchema = z.string().refine(
  (s) => {
    try {
      const url = new URL(s);
      return (url.protocol === "https:" || url.protocol === "http:") && url.origin === s;
    } catch {
      return false;
    }
  },
  { message: "Must be a bare origin like https://app.example.com (no path or trailing slash)" },
);

const createKeySchema = z.object({
  kind: z.enum(KEY_KINDS),
  label: z.string().max(120).optional(),
  allowed_origins: z.array(originSchema).max(50).optional(),
  scopes: scopesSchema.optional(),
});

const updateKeySchema = z
  .object({
    label: z.string().max(120).nullable().optional(),
    allowed_origins: z.array(originSchema).max(50).optional(),
    scopes: scopesSchema.optional(),
  })
  .strict();

function validationError(c: AppContext, issues: z.ZodIssue[]): Response {
  return c.json(
    {
      error: "Validation failed",
      issues: issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    },
    400,
  );
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

interface KeyRow {
  id: string;
  kind: string;
  prefix: string;
  label: string | null;
  allowedOrigins: string[] | null;
  scopes?: string[] | null;
  lastUsedAt: Date | null;
  createdAt: Date | null;
  revokedAt: Date | null;
}

function serializeKey(row: KeyRow) {
  return {
    id: row.id,
    kind: row.kind,
    prefix: row.prefix,
    label: row.label,
    allowed_origins: row.allowedOrigins ?? [],
    ...(row.kind === "admin" ? { scopes: row.scopes ?? [] } : {}),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    created_at: row.createdAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default function ingestionRoutes() {
  const r = new RoleRouter();

  /**
   * GET /v1/ingestion/keys
   * All keys for the tenant, active and revoked, oldest first.
   */
  r.get("/keys", "member", allowInstanceKey("keys:write"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const rows = await storeFor(db).apiIngestion.listKeys(tenantId);
    return c.json({ keys: rows.map(serializeKey) });
  });

  /**
   * POST /v1/ingestion/keys
   * Create a key. The response includes `key`, the raw secret, exactly once.
   */
  r.post("/keys", "member", allowInstanceKey("keys:write"), async (c) => {
    const parsed = createKeySchema.safeParse(c.var.body);
    if (!parsed.success) {
      return validationError(c, parsed.error.issues);
    }
    const { kind, label, allowed_origins, scopes } = parsed.data;

    if (c.var.tenant!.apiKeyId && kind !== "admin") {
      return c.json({ error: "Instance keys manage admin keys only." }, 403);
    }
    if (kind !== "publishable" && allowed_origins && allowed_origins.length > 0) {
      return c.json({ error: "allowed_origins applies to publishable keys only." }, 400);
    }
    if (kind === "admin") {
      if (c.var.tenant!.userRole !== "owner") {
        return c.json({ error: "Forbidden: only owners manage admin keys." }, 403);
      }
      if (!scopes) {
        return c.json({ error: "Admin keys need scopes.", scopes: ADMIN_SCOPES }, 400);
      }
    } else if (scopes) {
      return c.json({ error: "scopes applies to admin keys only." }, 400);
    }

    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const raw = KEY_PREFIX[kind] + randomBytes(32).toString("base64url");
    const keyHash = createHash("sha256").update(raw).digest("hex");

    const row = await storeFor(db).apiIngestion.createKey({
      tenantId,
      keyHash,
      prefix: raw.slice(0, 8),
      label: label ?? null,
      kind,
      allowedOrigins: kind === "publishable" ? (allowed_origins ?? null) : null,
      scopes: kind === "admin" ? [...new Set(scopes)] : null,
    });

    return c.json({ key: raw, ...serializeKey(row!) }, 201);
  });

  /**
   * PATCH /v1/ingestion/keys/:id
   * Update label and/or allowed_origins. allowed_origins is publishable-only.
   * A key belonging to another tenant returns 404.
   */
  r.patch("/keys/:id", "member", allowInstanceKey("keys:write"), async (c) => {
    const params = { id: c.req.param("id")! };
    const parsed = updateKeySchema.safeParse(c.var.body ?? {});
    if (!parsed.success) {
      return validationError(c, parsed.error.issues);
    }

    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const existing = await storeFor(db).apiIngestion.findKeyKind(tenantId, params.id);
    if (!existing) {
      return c.json({ error: "Key not found." }, 404);
    }

    if (existing.kind === "admin" && c.var.tenant!.userRole !== "owner") {
      return c.json({ error: "Forbidden: only owners manage admin keys." }, 403);
    }
    if (c.var.tenant!.apiKeyId && existing.kind !== "admin") {
      return c.json({ error: "Instance keys manage admin keys only." }, 403);
    }

    const updates: { label?: string | null; allowedOrigins?: string[]; scopes?: string[] } = {};
    if ("label" in parsed.data) {
      updates.label = parsed.data.label;
    }
    if ("allowed_origins" in parsed.data) {
      if (existing.kind !== "publishable") {
        return c.json({ error: "allowed_origins applies to publishable keys only." }, 400);
      }
      updates.allowedOrigins = parsed.data.allowed_origins;
    }
    if (parsed.data.scopes !== undefined) {
      if (existing.kind !== "admin") {
        return c.json({ error: "scopes applies to admin keys only." }, 400);
      }
      updates.scopes = [...new Set(parsed.data.scopes)];
    }
    if (Object.keys(updates).length === 0) {
      return c.json({ error: "Nothing to update." }, 400);
    }

    const row = await storeFor(db).apiIngestion.updateKey(params.id, updates);
    return c.json(serializeKey(row!));
  });

  /**
   * POST /v1/ingestion/keys/:id/revoke
   * Sets revoked_at. Idempotent: revoking an already-revoked key returns 200.
   */
  r.post("/keys/:id/revoke", "member", allowInstanceKey("keys:write"), async (c) => {
    const params = { id: c.req.param("id")! };
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const existing = await storeFor(db).apiIngestion.findKeyRevocation(tenantId, params.id);
    if (!existing) {
      return c.json({ error: "Key not found." }, 404);
    }
    const kind = await storeFor(db).apiIngestion.findKeyKind(tenantId, params.id);
    if (kind?.kind === "admin" && c.var.tenant!.userRole !== "owner") {
      return c.json({ error: "Forbidden: only owners manage admin keys." }, 403);
    }
    if (c.var.tenant!.apiKeyId && kind?.kind !== "admin") {
      return c.json({ error: "Instance keys manage admin keys only." }, 403);
    }

    if (existing.revokedAt === null) {
      await storeFor(db).apiIngestion.revokeKey(params.id, new Date());
    }
    return c.json({ success: true });
  });

  /**
   * GET /v1/ingestion/status
   * Drives the first-event indicator: the most recent event in the last 7
   * days plus a 24h count. Both queries are bounded on received_at so only
   * the newest monthly partitions are touched.
   */
  r.get("/status", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const last = await storeFor(db).apiIngestion.findLastEventSince(tenantId, sevenDaysAgo);
    const eventsLast24h = await storeFor(db).apiIngestion.countEventsSince(tenantId, oneDayAgo);

    return c.json({
      last_event: last
        ? {
            type: last.type,
            event_name: last.eventName,
            user_id: last.externalId,
            received_at: last.receivedAt.toISOString(),
          }
        : null,
      events_last_24h: eventsLast24h ?? 0,
    });
  });

  return r.app;
}
