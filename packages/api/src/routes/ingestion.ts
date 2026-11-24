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
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { apiKeys, contacts, events } from "@claros/db/schema";
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

function validationError(reply: any, issues: z.ZodIssue[]) {
  reply.status(400);
  return {
    error: "Validation failed",
    issues: issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
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

const KEY_COLUMNS = {
  id: apiKeys.id,
  kind: apiKeys.kind,
  prefix: apiKeys.prefix,
  label: apiKeys.label,
  allowedOrigins: apiKeys.allowedOrigins,
  lastUsedAt: apiKeys.lastUsedAt,
  createdAt: apiKeys.createdAt,
  revokedAt: apiKeys.revokedAt,
} as const;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ingestionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /v1/ingestion/keys
   * All keys for the tenant, active and revoked, oldest first.
   */
  app.get("/keys", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const rows = await db
      .select(KEY_COLUMNS)
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, tenantId))
      .orderBy(apiKeys.createdAt);
    return { keys: rows.map(serializeKey) };
  });

  /**
   * POST /v1/ingestion/keys
   * Create a key. The response includes `key`, the raw secret, exactly once.
   */
  app.post("/keys", { config: { minRole: "member" } }, async (request, reply) => {
    const parsed = createKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }
    const { kind, label, allowed_origins } = parsed.data;

    if (kind === "secret" && allowed_origins && allowed_origins.length > 0) {
      reply.status(400);
      return { error: "allowed_origins applies to publishable keys only." };
    }

    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const raw =
      (kind === "publishable" ? "cl_pub_" : "cl_live_") +
      randomBytes(32).toString("base64url");
    const keyHash = createHash("sha256").update(raw).digest("hex");

    const [row] = await db
      .insert(apiKeys)
      .values({
        tenantId,
        keyHash,
        prefix: raw.slice(0, 8),
        label: label ?? null,
        kind,
        allowedOrigins: kind === "publishable" ? (allowed_origins ?? null) : null,
      })
      .returning(KEY_COLUMNS);

    reply.status(201);
    return { key: raw, ...serializeKey(row!) };
  });

  /**
   * PATCH /v1/ingestion/keys/:id
   * Update label and/or allowed_origins. allowed_origins is publishable-only.
   * A key belonging to another tenant returns 404.
   */
  app.patch("/keys/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const params = request.params as { id: string };
    const parsed = updateKeySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const existing = await db
      .select({ id: apiKeys.id, kind: apiKeys.kind })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, params.id), eq(apiKeys.tenantId, tenantId)))
      .limit(1);
    if (existing.length === 0) {
      reply.status(404);
      return { error: "Key not found." };
    }

    const updates: Record<string, unknown> = {};
    if ("label" in parsed.data) {
      updates.label = parsed.data.label;
    }
    if ("allowed_origins" in parsed.data) {
      if (existing[0]!.kind !== "publishable") {
        reply.status(400);
        return { error: "allowed_origins applies to publishable keys only." };
      }
      updates.allowedOrigins = parsed.data.allowed_origins;
    }
    if (Object.keys(updates).length === 0) {
      reply.status(400);
      return { error: "Nothing to update." };
    }

    const [row] = await db
      .update(apiKeys)
      .set(updates)
      .where(eq(apiKeys.id, params.id))
      .returning(KEY_COLUMNS);
    return serializeKey(row!);
  });

  /**
   * POST /v1/ingestion/keys/:id/revoke
   * Sets revoked_at. Idempotent: revoking an already-revoked key returns 200.
   */
  app.post("/keys/:id/revoke", { config: { minRole: "member" } }, async (request, reply) => {
    const params = request.params as { id: string };
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const existing = await db
      .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, params.id), eq(apiKeys.tenantId, tenantId)))
      .limit(1);
    if (existing.length === 0) {
      reply.status(404);
      return { error: "Key not found." };
    }

    if (existing[0]!.revokedAt === null) {
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, params.id));
    }
    return { success: true };
  });

  /**
   * GET /v1/ingestion/status
   * Drives the first-event indicator: the most recent event in the last 7
   * days plus a 24h count. Both queries are bounded on received_at so only
   * the newest monthly partitions are touched.
   */
  app.get("/status", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const lastRows = await db
      .select({
        type: events.type,
        eventName: events.eventName,
        receivedAt: events.receivedAt,
        externalId: contacts.externalId,
      })
      .from(events)
      .innerJoin(contacts, eq(events.contactId, contacts.id))
      .where(and(eq(events.tenantId, tenantId), gte(events.receivedAt, sevenDaysAgo)))
      .orderBy(desc(events.receivedAt))
      .limit(1);

    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.tenantId, tenantId), gte(events.receivedAt, oneDayAgo)));

    const last = lastRows[0];
    return {
      last_event: last
        ? {
            type: last.type,
            event_name: last.eventName,
            user_id: last.externalId,
            received_at: last.receivedAt.toISOString(),
          }
        : null,
      events_last_24h: countRows[0]?.count ?? 0,
    };
  });
};

export default ingestionRoutes;
