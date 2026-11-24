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
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, and, ne, sql, inArray } from "drizzle-orm";
import { contacts, events, contactConflicts, lifecycleTransitions, tenants } from "@claros/db/schema";
import {
  evaluateEventTransition,
  isActivationRelevantEvent,
  checkActivationSatisfied,
  resolveLifecycleConfig,
  dedupLockKey,
  QUEUE,
  INGEST_TIMESTAMP_CLAMP_HOURS,
  type LifecycleState,
  type LifecycleConfig,
} from "@claros/core";
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
 * Advisory-lock dedup check within a transaction.
 * Acquires a transaction-scoped advisory lock keyed on (tenantId, messageId),
 * then checks if an event with the same messageId already exists.
 *
 * Must be called inside a transaction (the lock is released at tx end).
 * If deduplicated=true, the caller should skip the event insert entirely.
 */
async function attemptDedupInsert(
  tx: Db,
  tenantId: string,
  messageId: string,
): Promise<{ deduplicated: boolean }> {
  const lockKey = dedupLockKey(tenantId, messageId);
  // Acquire transaction-scoped advisory lock (blocks concurrent identical messageIds)
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);

  // Check if event already exists
  const existing = await tx.execute(
    sql`SELECT 1 FROM events WHERE tenant_id = ${tenantId} AND message_id = ${messageId} LIMIT 1`,
  );

  if (existing.rows.length > 0) {
    return { deduplicated: true };
  }
  return { deduplicated: false };
}

/**
 * Minimal contact upsert for track events: find-or-create by (tenant_id, external_id).
 * Sets last_seen_at on every call. New contacts get lifecycle_state = 'signed_up'.
 * Returns the contact ID and current lifecycle_state.
 *
 * Track events do NOT process traits - they only ensure the contact exists.
 */
async function ensureContact(
  db: Db,
  tenantId: string,
  externalId: string,
  now: Date,
): Promise<{ id: string; lifecycleState: LifecycleState }> {
  // Try to find existing contact first (most common path)
  const existing = await db
    .select({ id: contacts.id, lifecycleState: contacts.lifecycleState })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.externalId, externalId)))
    .limit(1);

  if (existing.length > 0) {
    const contact = existing[0]!;
    // Update last_seen_at and increment event counter
    await db
      .update(contacts)
      .set({
        lastSeenAt: now,
        eventCountBucketCurrent: sql<number>`COALESCE(event_count_bucket_current, 0) + 1`,
      })
      .where(eq(contacts.id, contact.id));
    return { id: contact.id, lifecycleState: contact.lifecycleState as LifecycleState };
  }

  // Contact does not exist - create with minimal fields.
  // Race condition: another request may create the same contact concurrently.
  // Handle with ON CONFLICT.
  const result = await db
    .insert(contacts)
    .values({
      tenantId,
      externalId,
      lifecycleState: "signed_up",
      firstSeenAt: now,
      lastSeenAt: now,
      eventCountBucketCurrent: 1,
    })
    .onConflictDoUpdate({
      target: [contacts.tenantId, contacts.externalId],
      set: {
        lastSeenAt: now,
        eventCountBucketCurrent: sql<number>`COALESCE("contacts"."event_count_bucket_current", 0) + 1`,
      },
    })
    .returning({ id: contacts.id, lifecycleState: contacts.lifecycleState });

  return {
    id: result[0]!.id,
    lifecycleState: result[0]!.lifecycleState as LifecycleState,
  };
}

/**
 * Result of processing identify traits for a contact.
 */
interface IdentifyResult {
  contactId: string;
  lifecycleState: LifecycleState;
  conflicts: Array<{ field: string; rejectedValue: string }>;
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

/**
 * Full contact upsert for identify events. Handles:
 * 1. Create contact if it does not exist (lifecycle_state = signed_up)
 * 2. Merge traits into reserved columns and properties JSONB atomically
 * 3. Detect email conflicts (email already held by another contact)
 * 4. Record conflicts for invalid payment_status values
 *
 * Concurrency: the properties merge uses Postgres jsonb operators (|| and -)
 * in a single UPDATE statement. This avoids the lost-update race that would
 * occur with read-modify-write in Node. The row-level lock Postgres holds
 * during the UPDATE serializes concurrent writes to the same contact.
 *
 * Email conflict detection: attempts the upsert with the email. If the
 * uq_contacts_tenant_email partial unique index fires (23505), we check the
 * constraint name to distinguish it from uq_contacts_tenant_external_id.
 * On email conflict: retry the upsert without the email, record the conflict.
 * One retry only - if the retry also fails, the error surfaces to the client.
 */
async function upsertContactWithTraits(
  db: Db,
  tenantId: string,
  externalId: string,
  traits: Record<string, unknown> | undefined,
  now: Date,
): Promise<IdentifyResult> {
  // If no traits, fall back to minimal upsert (same as track)
  if (!traits || Object.keys(traits).length === 0) {
    const { id: contactId, lifecycleState } = await ensureContact(db, tenantId, externalId, now);
    return { contactId, lifecycleState, conflicts: [] };
  }

  const { columnUpdates, propsToMerge, keysToRemove, conflicts } =
    partitionTraits(traits);

  // First, ensure the contact exists (may already exist from a prior track/identify)
  const { id: contactId, lifecycleState } = await ensureContact(db, tenantId, externalId, now);

  // Now apply trait updates. We separate email handling because it can conflict.
  const hasEmail = "email" in columnUpdates;
  const emailValue = columnUpdates.email;

  // Fast-path email conflict check: catches the common case without hitting
  // the unique index. This avoids a retry for the vast majority of conflicts.
  // However, it has a TOCTOU gap: two concurrent identifies with the same email
  // for different contacts can both pass this check. The 23505 catch below is
  // the actual safety net.
  let emailConflict = false;
  if (hasEmail && emailValue !== null && emailValue !== undefined) {
    const emailOwner = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.email, emailValue),
          ne(contacts.id, contactId),
        ),
      )
      .limit(1);

    if (emailOwner.length > 0) {
      emailConflict = true;
      conflicts.push({ field: "email", rejectedValue: emailValue });
    }
  }

  // Build the UPDATE - attempt with email if pre-check passed
  const updateResult = await attemptContactUpdate(
    db,
    contactId,
    columnUpdates,
    emailConflict,
    propsToMerge,
    keysToRemove,
  );

  if (updateResult.emailViolation) {
    // The pre-check missed a concurrent write. The uq_contacts_tenant_email
    // unique index caught it. Record the conflict and do NOT retry with the
    // email - it is definitively taken.
    emailConflict = true;
    conflicts.push({ field: "email", rejectedValue: emailValue! });

    // Retry once without the email column. If this also fails, let it surface
    // as a 500 to the client - that would indicate a different bug.
    await attemptContactUpdate(
      db,
      contactId,
      columnUpdates,
      true, // skip email on retry
      propsToMerge,
      keysToRemove,
    );
  }

  return { contactId, lifecycleState, conflicts };
}

/**
 * Postgres error shape from node-pg when a constraint is violated.
 * When thrown through Drizzle, the pg error is wrapped in DrizzleQueryError
 * as the `cause` property.
 */
interface PgError extends Error {
  code?: string;
  constraint?: string;
}

interface DrizzleQueryError extends Error {
  cause?: PgError;
}

/**
 * Attempt the UPDATE with the computed SET clause. Returns whether an email
 * unique violation occurred so the caller can retry without the email.
 *
 * Constraint handling:
 * - 23505 on uq_contacts_tenant_email: retryable. The email is owned by
 *   another contact. Caller should retry without the email and record a conflict.
 * - 23505 on any other constraint (e.g. uq_contacts_tenant_external_id): NOT
 *   retryable. This indicates a different bug and the error is re-thrown to
 *   surface as a 500.
 * - Any other error: re-thrown.
 */
async function attemptContactUpdate(
  db: Db,
  contactId: string,
  columnUpdates: {
    email?: string | null;
    name?: string | null;
    company?: string | null;
    paymentStatus?: string | null;
  },
  skipEmail: boolean,
  propsToMerge: Record<string, unknown>,
  keysToRemove: string[],
): Promise<{ emailViolation: boolean }> {
  const setClauses: Record<string, unknown> = {};

  // Reserved column updates (skip email if conflicting or on retry)
  if ("email" in columnUpdates && !skipEmail) {
    setClauses.email = columnUpdates.email;
  }
  if ("name" in columnUpdates) {
    setClauses.name = columnUpdates.name;
  }
  if ("company" in columnUpdates) {
    setClauses.company = columnUpdates.company;
  }
  if ("paymentStatus" in columnUpdates) {
    setClauses.paymentStatus = columnUpdates.paymentStatus;
  }

  // Properties JSONB merge - atomic in Postgres, no read-modify-write in Node.
  //
  // We use explicit `- text[]` for key removal rather than jsonb_strip_nulls().
  // Reason: jsonb_strip_nulls() recursively removes ALL null values from the
  // result, including nulls the customer legitimately stored at nested levels
  // in prior calls. The `- text[]` operator only removes the top-level keys
  // that THIS request explicitly set to null (unset semantics). Do not replace
  // with jsonb_strip_nulls - it is not equivalent.
  //
  // The array literal is built as ARRAY['k1','k2']::text[] because Drizzle's
  // parameter binding does not support Postgres array types directly.
  const hasPropsToMerge = Object.keys(propsToMerge).length > 0;
  const hasKeysToRemove = keysToRemove.length > 0;

  if (hasPropsToMerge || hasKeysToRemove) {
    let propsSql;
    const keysArrayLiteral = `ARRAY[${keysToRemove.map((k) => `'${k.replace(/'/g, "''")}'`).join(",")}]::text[]`;

    if (hasKeysToRemove && hasPropsToMerge) {
      propsSql = sql`(COALESCE(${contacts.properties}, '{}'::jsonb) - ${sql.raw(keysArrayLiteral)}) || ${JSON.stringify(propsToMerge)}::jsonb`;
    } else if (hasKeysToRemove) {
      propsSql = sql`COALESCE(${contacts.properties}, '{}'::jsonb) - ${sql.raw(keysArrayLiteral)}`;
    } else {
      propsSql = sql`COALESCE(${contacts.properties}, '{}'::jsonb) || ${JSON.stringify(propsToMerge)}::jsonb`;
    }
    setClauses.properties = propsSql;
  }

  // Nothing to write (e.g. all traits were email-only and email is skipped)
  if (Object.keys(setClauses).length === 0) {
    return { emailViolation: false };
  }

  try {
    await db
      .update(contacts)
      .set(setClauses as any)
      .where(eq(contacts.id, contactId));
    return { emailViolation: false };
  } catch (err: unknown) {
    // Drizzle wraps pg errors in DrizzleQueryError; the original pg error
    // with code/constraint lives on the `cause` property.
    const drizzleErr = err as DrizzleQueryError;
    const pgErr = drizzleErr.cause ?? (err as PgError);
    if (pgErr.code === "23505") {
      if (pgErr.constraint === "uq_contacts_tenant_email") {
        // Email is taken by another contact. Caller will retry without email.
        return { emailViolation: true };
      }
      // A different unique constraint fired - this is a bug, not a retryable
      // conflict. Re-throw so it surfaces as a 500.
      throw err;
    }
    throw err;
  }
}

/**
 * Record conflicts to the contact_conflicts table.
 * Conflicts are recorded AFTER the event is inserted (we need the event ID).
 */
async function recordConflicts(
  db: Db,
  tenantId: string,
  contactId: string,
  eventId: string,
  conflicts: Array<{ field: string; rejectedValue: string }>,
): Promise<void> {
  if (conflicts.length === 0) return;

  await db.insert(contactConflicts).values(
    conflicts.map((c) => ({
      tenantId,
      contactId,
      field: c.field,
      rejectedValue: c.rejectedValue,
      eventId,
    })),
  );
}

// --- Route Plugin ---

/** Job enqueue function shape (subset of PgBoss.send), injected by apps/server. */
type EnqueueFn = (queue: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<string | null>;

/**
 * Process one track event: dedup (when messageId present), contact upsert,
 * event insert, lifecycle transition, trigger-check enqueue.
 * Shared by POST /v1/track and POST /v1/batch.
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

  // If messageId is present, wrap in transaction with dedup check
  if (body.messageId) {
    const result = await db.transaction(async (tx) => {
      const { deduplicated } = await attemptDedupInsert(tx, tenantId, body.messageId!);
      if (deduplicated) {
        return { deduplicated: true as const };
      }

      // Contact upsert (includes event counter increment)
      const { id: contactId, lifecycleState } = await ensureContact(tx, tenantId, body.userId, now);

      // Insert event
      const [insertedEvent] = await tx.insert(events).values({
        tenantId,
        contactId,
        type: "track",
        eventName: body.event,
        properties: body.properties ?? null,
        context: eventContext,
        messageId: body.messageId ?? null,
        timestamp: eventTimestamp,
      }).returning({ id: events.id });

      // Evaluate lifecycle transition
      await evaluateAndApplyTransition(
        tx,
        tenantId,
        contactId,
        lifecycleState,
        body.event,
        insertedEvent!.id,
        now,
      );

      return { deduplicated: false as const, contactId, eventName: body.event };
    });

    if (result.deduplicated) {
      return { deduplicated: true };
    }

    // Enqueue trigger-check job (outside transaction)
    if (enqueue) {
      await enqueue(
        QUEUE.TRIGGER_CHECK,
        { tenant_id: tenantId, contact_id: result.contactId, event_name: result.eventName },
        { retryLimit: 2, retryDelay: 10, expireInMinutes: 5 },
      ).catch(() => {});
    }

    return { deduplicated: false };
  }

  // No messageId - original path (no dedup, no transaction wrapper)
  const { id: contactId, lifecycleState } = await ensureContact(db, tenantId, body.userId, now);

  // Insert event (returning ID for transition audit log)
  const [insertedEvent] = await db.insert(events).values({
    tenantId,
    contactId,
    type: "track",
    eventName: body.event,
    properties: body.properties ?? null,
    context: eventContext,
    messageId: body.messageId ?? null,
    timestamp: eventTimestamp,
  }).returning({ id: events.id });

  // Evaluate lifecycle transition
  await evaluateAndApplyTransition(
    db,
    tenantId,
    contactId,
    lifecycleState,
    body.event,
    insertedEvent!.id,
    now,
  );

  // Enqueue trigger-check job for event-triggered flow enrollment.
  // Fire-and-forget: if the queue is unavailable, the event is still recorded
  // and the contact can be enrolled by the next scan. Latency degrades from
  // seconds to the 15-min scan interval, which is acceptable.
  if (enqueue) {
    await enqueue(
      QUEUE.TRIGGER_CHECK,
      { tenant_id: tenantId, contact_id: contactId, event_name: body.event },
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

  // If messageId is present, wrap in transaction with dedup check
  if (body.messageId) {
    const result = await db.transaction(async (tx) => {
      const { deduplicated } = await attemptDedupInsert(tx, tenantId, body.messageId!);
      if (deduplicated) {
        return { deduplicated: true as const };
      }

      // Upsert contact with trait processing (includes event counter increment)
      const { contactId, lifecycleState, conflicts } = await upsertContactWithTraits(
        tx,
        tenantId,
        body.userId,
        body.traits as Record<string, unknown> | undefined,
        now,
      );

      // Insert identify event
      const [insertedEvent] = await tx
        .insert(events)
        .values({
          tenantId,
          contactId,
          type: "identify",
          eventName: null,
          properties: body.traits ?? null,
          context: eventContext,
          messageId: body.messageId ?? null,
          timestamp: eventTimestamp,
        })
        .returning({ id: events.id });

      // Record any conflicts
      if (conflicts.length > 0) {
        await recordConflicts(tx, tenantId, contactId, insertedEvent!.id, conflicts);
      }

      // Evaluate lifecycle transition
      await evaluateAndApplyTransition(
        tx,
        tenantId,
        contactId,
        lifecycleState,
        null,
        insertedEvent!.id,
        now,
      );

      return { deduplicated: false as const };
    });

    return { deduplicated: result.deduplicated };
  }

  // No messageId - original path (no dedup, no transaction wrapper)

  // Upsert contact with trait processing
  const { contactId, lifecycleState, conflicts } = await upsertContactWithTraits(
    db,
    tenantId,
    body.userId,
    body.traits as Record<string, unknown> | undefined,
    now,
  );

  // Insert identify event. Traits are stored in properties column.
  const [insertedEvent] = await db
    .insert(events)
    .values({
      tenantId,
      contactId,
      type: "identify",
      eventName: null,
      properties: body.traits ?? null,
      context: eventContext,
      messageId: body.messageId ?? null,
      timestamp: eventTimestamp,
    })
    .returning({ id: events.id });

  // Record any conflicts (email conflict, invalid payment_status)
  if (conflicts.length > 0) {
    await recordConflicts(
      db,
      tenantId,
      contactId,
      insertedEvent!.id,
      conflicts,
    );
  }

  // Evaluate lifecycle transition (identify events have no event name -
  // they still count as "activity" for at_risk/dormant/churned recovery,
  // but cannot satisfy activation_events since those require named track events)
  await evaluateAndApplyTransition(
    db,
    tenantId,
    contactId,
    lifecycleState,
    null, // identify events have no event name
    insertedEvent!.id,
    now,
  );

  return { deduplicated: false };
}

/**
 * Lifecycle transition result from evaluateAndApplyTransition.
 * Null if no transition occurred.
 */
interface TransitionResult {
  from: LifecycleState;
  to: LifecycleState;
}

/**
 * Evaluate and apply lifecycle state transition for an event.
 *
 * The sequence:
 * 1. Determine if this event could trigger a transition (pure logic, no I/O).
 * 2. For signed_up contacts needing activation check: load config, query events.
 * 3. Apply transition via CAS (atomic UPDATE WHERE lifecycle_state = $expected).
 * 4. On CAS success: write lifecycle_transitions audit row, set activated_at if needed.
 * 5. On CAS failure (concurrent write won): no-op, no audit row.
 *
 * Returns the transition that was applied, or null.
 */
async function evaluateAndApplyTransition(
  db: Db,
  tenantId: string,
  contactId: string,
  currentState: LifecycleState,
  eventName: string | null,
  eventId: string,
  now: Date,
): Promise<TransitionResult | null> {
  // Fast path: states that never transition on events
  if (currentState === "engaged" || currentState === "resurrected") {
    return null;
  }

  // For signed_up: need to check activation
  let activationSatisfied = false;
  if (currentState === "signed_up") {
    // Load lifecycle config from tenant settings (only query in this path).
    // This query fires only for signed_up contacts where the event MIGHT be
    // an activation event. A contact hits this path at most once in their lifetime
    // (after activation, they leave signed_up permanently).
    const config = await loadLifecycleConfig(db, tenantId);

    // Short-circuit: no activation_events configured means no auto-activation
    if (config.activation_events.length === 0) {
      return null;
    }

    // Short-circuit: this event is not in the activation_events list
    if (!isActivationRelevantEvent(eventName, config.activation_events)) {
      return null;
    }

    // This event IS in activation_events. Query distinct event names for
    // this contact to check if ALL activation events are now satisfied.
    // Bounded by activation_events.length (we only need to check those names).
    const distinctEvents = await db
      .selectDistinct({ eventName: events.eventName })
      .from(events)
      .where(
        and(
          eq(events.contactId, contactId),
          eq(events.type, "track"),
          inArray(events.eventName, config.activation_events),
        ),
      );

    const contactEventNames = new Set(
      distinctEvents.map((r) => r.eventName).filter((n): n is string => n !== null),
    );
    // Include the current event (it is already inserted by the time we get here)
    if (eventName !== null) {
      contactEventNames.add(eventName);
    }

    activationSatisfied = checkActivationSatisfied(
      contactEventNames,
      config.activation_events,
    );
  } else {
    // For at_risk, dormant, churned: any activity triggers transition.
    // activationSatisfied is irrelevant for these states.
    activationSatisfied = false;
  }

  // Evaluate the pure transition logic
  const transition = evaluateEventTransition({
    currentState,
    eventName,
    activationSatisfied,
  });

  if (transition === null) {
    return null;
  }

  // Apply via CAS: only succeeds if lifecycle_state still matches expected value.
  // If another request already transitioned this contact, the CAS fails silently
  // (0 rows updated) and we do NOT write an audit row. This is the idempotency
  // guarantee: same event delivered twice cannot write two transition rows.
  const setClauses: Record<string, unknown> = {
    lifecycleState: transition.to,
  };

  // activated_at: set once, never cleared. Only on signed_up -> activated.
  if (transition.setActivatedAt) {
    setClauses.activatedAt = sql`COALESCE(${contacts.activatedAt}, ${now.toISOString()}::timestamptz)`;
  }

  const updated = await db
    .update(contacts)
    .set(setClauses as any)
    .where(
      and(
        eq(contacts.id, contactId),
        eq(contacts.lifecycleState, transition.from),
      ),
    )
    .returning({ id: contacts.id });

  if (updated.length === 0) {
    // CAS failed: state was already changed by a concurrent request. No-op.
    return null;
  }

  // CAS succeeded: write audit log
  await db.insert(lifecycleTransitions).values({
    tenantId,
    contactId,
    fromState: transition.from,
    toState: transition.to,
    triggerEventId: eventId,
    metadata: null,
    transitionedAt: now,
  });

  return { from: transition.from, to: transition.to };
}

/**
 * Load lifecycle config from tenant settings.
 * Returns resolved config (defaults merged with overrides).
 */
async function loadLifecycleConfig(db: Db, tenantId: string): Promise<LifecycleConfig> {
  const rows = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const settings = rows[0]?.settings as Record<string, unknown> | null | undefined;
  const lifecycleOverrides = settings?.lifecycle as Partial<LifecycleConfig> | null | undefined;
  return resolveLifecycleConfig(lifecycleOverrides);
}

const ingestRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /v1/track
   *
   * Record a behavioral event for a known user.
   * Track events only ensure the contact exists and update last_seen_at.
   * They do NOT process traits.
   */
  app.post("/track", async (request, reply) => {
    const parsed = trackBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return {
        error: "Validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      };
    }

    const tenantId = request.ingestTenant!.id;
    const db: Db = request.server.db;
    const { deduplicated } = await processTrackEvent(
      db,
      request.server.enqueue,
      tenantId,
      parsed.data,
    );
    if (parsed.data.messageId) {
      return { success: true, deduplicated };
    }
    return { success: true };
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
  app.post("/identify", async (request, reply) => {
    const parsed = identifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return {
        error: "Validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      };
    }

    const tenantId = request.ingestTenant!.id;
    const db: Db = request.server.db;
    const { deduplicated } = await processIdentifyEvent(db, tenantId, parsed.data);
    if (parsed.data.messageId) {
      return { success: true, deduplicated };
    }
    return { success: true };
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
   * - Caps: 100 items per batch, 512 KB request body (route bodyLimit),
   *   matching the spirit of Segment's 32KB/event + 500KB/batch contract.
   * - The whole batch counts as ONE request against the key's rate limit.
   */
  app.post("/batch", { bodyLimit: 512 * 1024 }, async (request, reply) => {
    const parsed = batchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return {
        error: "Validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      };
    }

    const tenantId = request.ingestTenant!.id;
    const db: Db = request.server.db;
    const enqueue = request.server.enqueue;

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

    return { success: true, received, errors };
  });
};

export default ingestRoutes;
