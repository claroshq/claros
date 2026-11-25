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
 *                 stricter rate limit. Prefix cl_pub_.
 *   secret      - server-side. Prefix cl_live_ (matches the pre-existing
 *                 README convention).
 *
 * Only the SHA-256 hash of a key is stored. The raw value is returned by
 * POST once and is unrecoverable afterwards; the prefix column supports
 * masked display (cl_pub_ab...).
 *
 * GET /v1/ingestion/status powers the "waiting for your first event"
 * indicator on the Integrate screen. Events queries are bounded to recent
 * partitions (received_at >= now - 7 days) because events is partitioned by
 * received_at and an unbounded ORDER BY received_at DESC would scan every
 * partition.
 */
import { createHash, randomBytes } from "node:crypto";
import { RoleRouter } from "../http/router.js";
import type { AppContext } from "../http/env.js";
import { z } from "zod";
import { storeFor } from "@claros/store";
import type { Db } from "../plugins/db.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const KEY_KINDS = ["publishable", "secret"] as const;

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
});

const updateKeySchema = z
  .object({
    label: z.string().max(120).nullable().optional(),
    allowed_origins: z.array(originSchema).max(50).optional(),
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
  r.get("/keys", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const rows = await storeFor(db).apiIngestion.listKeys(tenantId);
    return c.json({ keys: rows.map(serializeKey) });
  });

  /**
   * POST /v1/ingestion/keys
   * Create a key. The response includes `key`, the raw secret, exactly once.
   */
  r.post("/keys", "member", async (c) => {
    const parsed = createKeySchema.safeParse(c.var.body);
    if (!parsed.success) {
      return validationError(c, parsed.error.issues);
    }
    const { kind, label, allowed_origins } = parsed.data;

    if (kind === "secret" && allowed_origins && allowed_origins.length > 0) {
      return c.json({ error: "allowed_origins applies to publishable keys only." }, 400);
    }

    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const raw =
      (kind === "publishable" ? "cl_pub_" : "cl_live_") +
      randomBytes(32).toString("base64url");
    const keyHash = createHash("sha256").update(raw).digest("hex");

    const row = await storeFor(db).apiIngestion.createKey({
      tenantId,
      keyHash,
      prefix: raw.slice(0, 8),
      label: label ?? null,
      kind,
      allowedOrigins: kind === "publishable" ? (allowed_origins ?? null) : null,
    });

    return c.json({ key: raw, ...serializeKey(row!) }, 201);
  });

  /**
   * PATCH /v1/ingestion/keys/:id
   * Update label and/or allowed_origins. allowed_origins is publishable-only.
   * A key belonging to another tenant returns 404.
   */
  r.patch("/keys/:id", "member", async (c) => {
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

    const updates: { label?: string | null; allowedOrigins?: string[] } = {};
    if ("label" in parsed.data) {
      updates.label = parsed.data.label;
    }
    if ("allowed_origins" in parsed.data) {
      if (existing.kind !== "publishable") {
        return c.json({ error: "allowed_origins applies to publishable keys only." }, 400);
      }
      updates.allowedOrigins = parsed.data.allowed_origins;
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
  r.post("/keys/:id/revoke", "member", async (c) => {
    const params = { id: c.req.param("id")! };
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const existing = await storeFor(db).apiIngestion.findKeyRevocation(tenantId, params.id);
    if (!existing) {
      return c.json({ error: "Key not found." }, 404);
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
