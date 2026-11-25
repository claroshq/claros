/**
 * Event ingestion routes: POST /v1/track, POST /v1/identify, POST /v1/batch.
 *
 * Segment-compatible endpoints for receiving behavioral events and identity
 * traits from a tenant's product. Authenticated via per-tenant write keys
 * (Bearer token, Segment-style Basic auth, or - publishable keys only - a
 * body `key` field for the browser beacon path), NOT via session cookies.
 *
 * Design decisions:
 * - Anonymous tracking (no userId) is explicitly out of scope. All endpoints
 *   require userId, which maps to contacts.external_id. This is a deliberate
 *   decision, not an omission - see docs/BACKLOG.md. In a batch, anonymous
 *   items fail validation and are reported in errors[] without aborting the
 *   rest.
 * - Server-side dedup: clients sending messageId get at-most-once insert via
 *   a transaction-scoped advisory lock plus a lookup on
 *   idx_events_dedup_lookup. Clients that omit it keep insert-always
 *   behavior.
 * - /batch exists because Segment SDKs post only to /v1/batch by default;
 *   without it the Segment-compatibility claim is false. Caps: 100 items,
 *   512 KB body.
 *
 * Task 8 additions (contact model):
 * - Identify processes traits: reserved trait names (email, name, company,
 *   payment_status/plan) map to dedicated columns. All others go into the
 *   properties JSONB via atomic shallow merge in Postgres.
 * - Null trait values mean "unset" - the key is removed from properties JSONB,
 *   or the reserved column is set to NULL.
 * - Email conflict: if email is already held by another contact in the same
 *   tenant, the email update is rejected and a contact_conflicts row is written.
 *   Detection is two-layer: a fast-path SELECT pre-check catches the common case,
 *   and a 23505 catch on uq_contacts_tenant_email handles the concurrent race.
 *   On violation: one retry without the email, then stop. If the retry also
 *   fails, the error surfaces as a 500 to the client.
 * - Invalid payment_status: rejected and recorded as a conflict.
 * - Concurrency: properties merge uses Postgres jsonb operators (|| and -)
 *   in a single UPDATE to avoid lost-update races. No read-modify-write in Node.
 *
 * Task 9 additions (lifecycle state machine):
 * - After event insertion, evaluates whether the event triggers a lifecycle
 *   state transition. Transition evaluation uses pure functions from @claros/core.
 * - Transition is applied via atomic CAS (WHERE lifecycle_state = $expected).
 *   If CAS fails (concurrent write), no transition row is written - idempotent.
 * - lifecycle_transitions audit log is written on successful CAS.
 * - activated_at is set once (signed_up -> activated) and never cleared.
 * - Activation check: for signed_up contacts, queries distinct event names
 *   to verify all activation_events are satisfied. Short-circuits: no query
 *   when contact is not signed_up, when tenant has no activation_events,
 *   or when the event name is not in the activation_events list.
 * - Lifecycle config is loaded from tenants.settings.lifecycle ONLY when
 *   the contact is in signed_up state and the event is activation-relevant.
 *   Other event-driven transitions (at_risk/dormant/churned recovery) do not
 *   need config - they trigger on any activity.
 * - engagement_depth is NOT touched by this task.
 */
import { createRouter, parseBody } from "../http/router.js";
import { createIngestAuth, ingestPreflight, parsePlainTextAsJson } from "../http/ingest-auth.js";
import type { AppContext } from "../http/env.js";
import { z } from "zod";
import { storeFor } from "@claros/store";
import { QUEUE, INGEST_TIMESTAMP_CLAMP_HOURS } from "@claros/core";
import type { Db } from "../plugins/db.js";

// --- Constants ---

/**
 * Maximum hours of clock skew tolerated between client timestamp and server
 * time. Sourced from @claros/core so the worker's partition-pruning slack
 * and this ingest clamp share a single definition and cannot drift.
 */
const TIMESTAMP_CLAMP_HOURS = INGEST_TIMESTAMP_CLAMP_HOURS;

/** Valid values for the payment_status column. */
const VALID_PAYMENT_STATUSES = new Set([
  "free",
  "trial",
  "paid",
  "past_due",
  "cancelled",
]);

/**
 * Trait keys that map to dedicated columns rather than properties JSONB.
 * "plan" is accepted as an alias for "payment_status".
 */
const RESERVED_TRAIT_KEYS = new Set([
  "email",
  "name",
  "company",
  "payment_status",
  "plan",
]);

// --- Zod Schemas ---

const contextSchema = z
  .object({
    ip: z.string().optional(),
    userAgent: z.string().optional(),
  })
  .passthrough() // Allow additional context fields
  .optional();

const trackBodySchema = z.object({
  userId: z.string().min(1, "userId is required"),
  event: z.string().min(1, "event name is required"),
  properties: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  context: contextSchema,
  messageId: z.string().optional(),
  // Browser beacon path: publishable key in the body (see ingest-auth.ts).
  // Consumed by the auth hook before the handler runs; never persisted.
  key: z.string().optional(),
});

const identifyBodySchema = z.object({
  userId: z.string().min(1, "userId is required"),
  traits: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  context: contextSchema,
  messageId: z.string().optional(),
  key: z.string().optional(),
});

export type TrackBody = z.infer<typeof trackBodySchema>;
export type IdentifyBody = z.infer<typeof identifyBodySchema>;

/** Batch envelope (Segment-compatible): items carry a type discriminator. */
const batchItemSchema = z.discriminatedUnion("type", [
  trackBodySchema.extend({ type: z.literal("track") }),
  identifyBodySchema.extend({ type: z.literal("identify") }),
]);

/**
 * The envelope is validated loosely on purpose: items are validated
 * individually in the handler so one malformed item fails its own slot in
 * errors[] instead of rejecting the entire batch.
 */
const batchBodySchema = z.object({
  batch: z.array(z.unknown()).min(1).max(100),
});

// --- Helpers ---

/**
 * Clamp a client-supplied timestamp to within +/- TIMESTAMP_CLAMP_HOURS of server time.
 * If the client timestamp is outside the window, returns serverNow and marks clamped=true.
 * This prevents unbounded backdating and future-dating of events.
 */
function clampTimestamp(
  clientTs: Date,
  serverNow: Date,
): { timestamp: Date; clamped: boolean } {
  const diffMs = Math.abs(clientTs.getTime() - serverNow.getTime());
  const limitMs = TIMESTAMP_CLAMP_HOURS * 60 * 60 * 1000;
  if (diffMs > limitMs) {
    return { timestamp: serverNow, clamped: true };
  }
  return { timestamp: clientTs, clamped: false };
}

/**
 * Separate incoming traits into reserved column values and properties JSONB entries.
 * Returns:
 * - columnUpdates: values for reserved columns (email, name, company, payment_status)
 * - propsToMerge: non-null non-reserved traits to add/overwrite in properties JSONB
 * - keysToRemove: trait keys whose value was null (unset semantics)
 * - conflicts: trait values that fail validation (e.g. invalid payment_status)
 */
function partitionTraits(traits: Record<string, unknown>): {
  columnUpdates: {
    email?: string | null;
    name?: string | null;
    company?: string | null;
    paymentStatus?: string | null;
  };
  propsToMerge: Record<string, unknown>;
  keysToRemove: string[];
  conflicts: Array<{ field: string; rejectedValue: string }>;
} {
  const columnUpdates: {
    email?: string | null;
    name?: string | null;
    company?: string | null;
    paymentStatus?: string | null;
  } = {};
  const propsToMerge: Record<string, unknown> = {};
  const keysToRemove: string[] = [];
  const conflicts: Array<{ field: string; rejectedValue: string }> = [];

  for (const [key, value] of Object.entries(traits)) {
    if (key === "email") {
      if (value === null) {
        columnUpdates.email = null;
      } else if (typeof value === "string") {
        columnUpdates.email = value;
      }
      // Non-string non-null email is ignored (not stored anywhere)
    } else if (key === "name") {
      if (value === null) {
        columnUpdates.name = null;
      } else if (typeof value === "string") {
        columnUpdates.name = value;
      }
    } else if (key === "company") {
      if (value === null) {
        columnUpdates.company = null;
      } else if (typeof value === "string") {
        columnUpdates.company = value;
      }
    } else if (key === "payment_status" || key === "plan") {
      if (value === null) {
        columnUpdates.paymentStatus = null;
      } else if (typeof value === "string") {
        if (VALID_PAYMENT_STATUSES.has(value)) {
          columnUpdates.paymentStatus = value;
        } else {
          // Invalid payment_status - record as conflict, do not apply
          conflicts.push({ field: "payment_status", rejectedValue: value });
        }
      }
    } else {
      // Non-reserved trait: goes into properties JSONB
      if (value === null) {
        keysToRemove.push(key);
      } else {
        propsToMerge[key] = value;
      }
    }
  }

  return { columnUpdates, propsToMerge, keysToRemove, conflicts };
}

// --- Route Plugin ---

/** Job enqueue function shape (subset of PgBoss.send), injected by apps/server. */
type EnqueueFn = (queue: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<string | null>;

/**
 * Process one track event: dedup (when messageId present), contact upsert,
 * event insert, lifecycle transition, trigger-check enqueue.
 * Shared by POST /v1/track and POST /v1/batch.
 *
 * Database work (dedup transaction, contact upsert, event insert, lifecycle
 * transition) runs in apiIngest.recordTrackEvent; the enqueue stays here,
 * outside any transaction.
 */
async function processTrackEvent(
  db: Db,
  enqueue: EnqueueFn | undefined,
  tenantId: string,
  body: TrackBody,
): Promise<{ deduplicated: boolean }> {
  const now = new Date();
  const rawTimestamp = body.timestamp ? new Date(body.timestamp) : now;
  const { timestamp: eventTimestamp, clamped } = clampTimestamp(rawTimestamp, now);

  // Build context, annotating if timestamp was clamped
  const eventContext = clamped
    ? { ...(body.context ?? {}), _timestamp_clamped: true }
    : (body.context ?? null);

  const result = await storeFor(db).apiIngest.recordTrackEvent({
    tenantId,
    userId: body.userId,
    eventName: body.event,
    properties: body.properties ?? null,
    context: eventContext,
    messageId: body.messageId,
    timestamp: eventTimestamp,
    now,
  });

  if (result.deduplicated) {
    return { deduplicated: true };
  }

  // Enqueue trigger-check job for event-triggered flow enrollment (outside
  // the dedup transaction when there is one).
  // Fire-and-forget: if the queue is unavailable, the event is still recorded
  // and the contact can be enrolled by the next scan. Latency degrades from
  // seconds to the 15-min scan interval, which is acceptable.
  if (enqueue) {
    await enqueue(
      QUEUE.TRIGGER_CHECK,
      { tenant_id: tenantId, contact_id: result.contactId, event_name: body.event },
      { retryLimit: 2, retryDelay: 10, expireInMinutes: 5 },
    ).catch(() => {
      // Swallow enqueue failures: the event is persisted, enrollment will
      // happen on the next scan if the job queue is temporarily unavailable.
    });
  }

  return { deduplicated: false };
}

/**
 * Process one identify event: contact upsert with trait processing, event
 * insert, conflict recording, lifecycle transition.
 * Shared by POST /v1/identify and POST /v1/batch.
 *
 * Traits are partitioned here (pure); the database work, including the
 * messageId dedup transaction, runs in apiIngest.recordIdentifyEvent.
 */
async function processIdentifyEvent(
  db: Db,
  tenantId: string,
  body: IdentifyBody,
): Promise<{ deduplicated: boolean }> {
  const now = new Date();
  const rawTimestamp = body.timestamp ? new Date(body.timestamp) : now;
  const { timestamp: eventTimestamp, clamped } = clampTimestamp(rawTimestamp, now);

  // Build context, annotating if timestamp was clamped
  const eventContext = clamped
    ? { ...(body.context ?? {}), _timestamp_clamped: true }
    : (body.context ?? null);

  // No traits (absent or empty) means a minimal contact upsert, same as track.
  const traits = body.traits as Record<string, unknown> | undefined;
  const traitPlan = !traits || Object.keys(traits).length === 0 ? null : partitionTraits(traits);

  const result = await storeFor(db).apiIngest.recordIdentifyEvent({
    tenantId,
    userId: body.userId,
    traits: body.traits ?? null,
    traitPlan,
    context: eventContext,
    messageId: body.messageId,
    timestamp: eventTimestamp,
    now,
  });

  // Topic consent (G8a): traits.topics = { <slug>: boolean } sets the
  // contact's topic statuses (source 'identify'). Slugs that are not topics of
  // the product, and non-boolean values, are ignored (the identify response
  // has no warnings field). The trait is also kept in properties like any other.
  if (!result.deduplicated) {
    const wanted = topicTrait(traits);
    if (wanted) {
      await storeFor(db).apiIngest.applyContactTopics({
        tenantId,
        externalId: body.userId,
        topics: wanted,
        source: "identify",
        now,
      });
    }
  }

  return result;
}

/** Most topics one identify call may set. */
const MAX_TOPIC_TRAITS = 100;

/** The boolean entries of traits.topics, or null when there are none. */
function topicTrait(traits: Record<string, unknown> | undefined): Record<string, boolean> | null {
  const raw = traits?.topics;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, boolean> = {};
  let n = 0;
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "boolean" || slug.length === 0) continue;
    out[slug] = value;
    if (++n >= MAX_TOPIC_TRAITS) break;
  }
  return n > 0 ? out : null;
}

/** Validation failure response shared by the three ingestion routes. */
function validationFailed(c: AppContext, issues: z.ZodIssue[]): Response {
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

/**
 * Ingestion routes, mounted at /v1 in app.ts. Per route: body parsing
 * (text/plain parsed as JSON for the browser beacon path), then API key
 * auth (one shared instance, so rate-limit and last_used_at state is per
 * app), then the handler. OPTIONS preflights are answered without auth.
 */
export default function ingestRoutes() {
  const app = createRouter();
  const ingestAuth = createIngestAuth();
  const parsers = { "text/plain": parsePlainTextAsJson };
  const defaultBody = parseBody({ parsers });
  const batchBody = parseBody({ parsers, limit: 512 * 1024 });

  app.options("/track", defaultBody, ingestPreflight);
  app.options("/identify", defaultBody, ingestPreflight);
  app.options("/batch", batchBody, ingestPreflight);

  /**
   * POST /v1/track
   *
   * Record a behavioral event for a known user.
   * Track events only ensure the contact exists and update last_seen_at.
   * They do NOT process traits.
   */
  app.post("/track", defaultBody, ingestAuth, async (c) => {
    const parsed = trackBodySchema.safeParse(c.var.body);
    if (!parsed.success) {
      return validationFailed(c, parsed.error.issues);
    }

    const tenantId = c.var.ingestTenant!.id;
    const db: Db = c.var.db;
    const { deduplicated } = await processTrackEvent(
      db,
      c.var.enqueue,
      tenantId,
      parsed.data,
    );
    if (parsed.data.messageId) {
      return c.json({ success: true, deduplicated });
    }
    return c.json({ success: true });
  });

  /**
   * POST /v1/identify
   *
   * Associate traits with a known user. Creates the contact if it does not exist.
   * Processes traits:
   * - Reserved traits (email, name, company, payment_status/plan) update columns
   * - All other traits are shallow-merged into properties JSONB
   * - Null values mean "unset" (remove key from properties, set column to NULL)
   * - Email conflicts are detected and recorded (not applied)
   * - Invalid payment_status values are rejected and recorded as conflicts
   */
  app.post("/identify", defaultBody, ingestAuth, async (c) => {
    const parsed = identifyBodySchema.safeParse(c.var.body);
    if (!parsed.success) {
      return validationFailed(c, parsed.error.issues);
    }

    const tenantId = c.var.ingestTenant!.id;
    const db: Db = c.var.db;
    const { deduplicated } = await processIdentifyEvent(db, tenantId, parsed.data);
    if (parsed.data.messageId) {
      return c.json({ success: true, deduplicated });
    }
    return c.json({ success: true });
  });

  /**
   * POST /v1/batch
   *
   * Segment-compatible batch envelope: { batch: [...] } where each item is a
   * track or identify call with a "type" discriminator. This is the endpoint
   * Segment SDKs post to by default (analytics-node: host + /v1/batch), so
   * its existence is what makes "point an existing Segment SDK at Claros"
   * true rather than aspirational.
   *
   * Semantics:
   * - 200 with per-item results; invalid items are reported in errors[] and
   *   do not abort the batch (Segment's own behavior: a batch is accepted
   *   or rejected as a unit only on auth/size failure).
   * - Anonymous items (no userId) fail validation and land in errors[] -
   *   anonymous tracking is out of scope (see file header).
   * - Caps: 100 items per batch, 512 KB request body (route body limit),
   *   matching the spirit of Segment's 32KB/event + 500KB/batch contract.
   * - The whole batch counts as ONE request against the key's rate limit.
   */
  app.post("/batch", batchBody, ingestAuth, async (c) => {
    const parsed = batchBodySchema.safeParse(c.var.body);
    if (!parsed.success) {
      return validationFailed(c, parsed.error.issues);
    }

    const tenantId = c.var.ingestTenant!.id;
    const db: Db = c.var.db;
    const enqueue = c.var.enqueue;

    let received = 0;
    const errors: Array<{ index: number; message: string }> = [];

    for (const [index, rawItem] of parsed.data.batch.entries()) {
      const itemParsed = batchItemSchema.safeParse(rawItem);
      if (!itemParsed.success) {
        errors.push({
          index,
          message: itemParsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
        continue;
      }
      const item = itemParsed.data;
      try {
        if (item.type === "track") {
          await processTrackEvent(db, enqueue, tenantId, item);
        } else {
          await processIdentifyEvent(db, tenantId, item);
        }
        received += 1;
      } catch (err) {
        errors.push({
          index,
          message: err instanceof Error ? err.message : "processing failed",
        });
      }
    }

    return c.json({ success: true, received, errors });
  });

  return app;
}
