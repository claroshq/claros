/**
 * Postgres implementation of the queries used by packages/api/src/routes/ingest.ts.
 *
 * The ingestion hot path: messageId dedup (transaction-scoped advisory lock),
 * contact upsert with trait merge and email-conflict handling, event insert,
 * conflict recording, and the lifecycle transition CAS. The helpers below are
 * the statements the route ran before, moved unchanged; each exported method
 * runs them in the same order and with the same transaction boundary.
 */
import { eq, and, ne, sql, inArray } from "drizzle-orm";
import { contacts, events, contactConflicts, lifecycleTransitions, tenants } from "@claros/db/schema";
import {
  evaluateEventTransition,
  isActivationRelevantEvent,
  checkActivationSatisfied,
  resolveLifecycleConfig,
  dedupLockKey,
  type LifecycleState,
  type LifecycleConfig,
} from "@claros/core";
import type { PgDb } from "./db.js";
import type { ApiIngestQueries, IngestTraitPlan } from "../areas/api-ingest.js";
import { topics as topicsTable } from "@claros/db/schema";
import { upsertContactTopicSql } from "./contact-topics.js";
import { pgWriteOutbox } from "./outbox.js";
import { identifyTopicEvents } from "../shared/topic-events.js";
import { contactTopics as contactTopicsTable } from "@claros/db/schema";
import { pgSyncContactDates } from "./contact-dates.js";

/**
 * Advisory-lock dedup check within a transaction.
 * Acquires a transaction-scoped advisory lock keyed on (tenantId, messageId),
 * then checks if an event with the same messageId already exists.
 *
 * Must be called inside a transaction (the lock is released at tx end).
 * If deduplicated=true, the caller should skip the event insert entirely.
 */
async function attemptDedupInsert(
  tx: PgDb,
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
  db: PgDb,
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
  db: PgDb,
  tenantId: string,
  externalId: string,
  traitPlan: IngestTraitPlan | null,
  now: Date,
): Promise<IdentifyResult> {
  // If no traits, fall back to minimal upsert (same as track).
  // The caller passes a null plan when traits are absent or empty.
  if (!traitPlan) {
    const { id: contactId, lifecycleState } = await ensureContact(db, tenantId, externalId, now);
    return { contactId, lifecycleState, conflicts: [] };
  }

  // Traits were partitioned by the caller (partitionTraits in ingest.ts).
  const { columnUpdates, propsToMerge, keysToRemove } = traitPlan;
  const conflicts = [...traitPlan.conflicts];

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
  db: PgDb,
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
  db: PgDb,
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
  db: PgDb,
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
async function loadLifecycleConfig(db: PgDb, tenantId: string): Promise<LifecycleConfig> {
  const rows = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const settings = rows[0]?.settings as Record<string, unknown> | null | undefined;
  const lifecycleOverrides = settings?.lifecycle as Partial<LifecycleConfig> | null | undefined;
  return resolveLifecycleConfig(lifecycleOverrides);
}


export function pgApiIngest(db: PgDb): ApiIngestQueries {
  return {
    async recordTrackEvent(input) {
      const { tenantId, userId, eventName, properties, context: eventContext, messageId, timestamp: eventTimestamp, now } = input;

      // If messageId is present, wrap in transaction with dedup check
      if (messageId) {
        const result = await db.transaction(async (tx) => {
          const { deduplicated } = await attemptDedupInsert(tx, tenantId, messageId);
          if (deduplicated) {
            return { deduplicated: true as const };
          }

          // Contact upsert (includes event counter increment)
          const { id: contactId, lifecycleState } = await ensureContact(tx, tenantId, userId, now);

          // Insert event
          const [insertedEvent] = await tx.insert(events).values({
            tenantId,
            contactId,
            type: "track",
            eventName,
            properties,
            context: eventContext,
            messageId: messageId ?? null,
            timestamp: eventTimestamp,
          }).returning({ id: events.id });

          // Evaluate lifecycle transition
          await evaluateAndApplyTransition(
            tx,
            tenantId,
            contactId,
            lifecycleState,
            eventName,
            insertedEvent!.id,
            now,
          );

          return { deduplicated: false as const, contactId };
        });

        return result;
      }

      // No messageId - original path (no dedup, no transaction wrapper)
      const { id: contactId, lifecycleState } = await ensureContact(db, tenantId, userId, now);

      // Insert event (returning ID for transition audit log)
      const [insertedEvent] = await db.insert(events).values({
        tenantId,
        contactId,
        type: "track",
        eventName,
        properties,
        context: eventContext,
        messageId: messageId ?? null,
        timestamp: eventTimestamp,
      }).returning({ id: events.id });

      // Evaluate lifecycle transition
      await evaluateAndApplyTransition(
        db,
        tenantId,
        contactId,
        lifecycleState,
        eventName,
        insertedEvent!.id,
        now,
      );

      return { deduplicated: false, contactId };
    },

    async recordIdentifyEvent(input) {
      const { tenantId, userId, traits, traitPlan, context: eventContext, messageId, timestamp: eventTimestamp, now } = input;

      // If messageId is present, wrap in transaction with dedup check
      if (messageId) {
        const result = await db.transaction(async (tx) => {
          const { deduplicated } = await attemptDedupInsert(tx, tenantId, messageId);
          if (deduplicated) {
            return { deduplicated: true as const };
          }

          // Upsert contact with trait processing (includes event counter increment)
          const { contactId, lifecycleState, conflicts } = await upsertContactWithTraits(
            tx,
            tenantId,
            userId,
            traitPlan,
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
              properties: traits,
              context: eventContext,
              messageId: messageId ?? null,
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
        userId,
        traitPlan,
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
          properties: traits,
          context: eventContext,
          messageId: messageId ?? null,
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
    },

    async syncContactDates({ tenantId, externalId, changedKeys, now }) {
      const t = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      const declared = (t[0]?.settings as { date_traits?: unknown } | null | undefined)?.date_traits;
      const properties = Array.isArray(declared) ? declared.filter((k): k is string => typeof k === "string") : [];
      if (properties.length === 0 || !changedKeys.some((k) => properties.includes(k))) return 0;
      const rows = await db
        .select({ id: contacts.id, properties: contacts.properties })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.externalId, externalId)))
        .limit(1);
      if (rows.length === 0) return 0;
      return pgSyncContactDates(db, tenantId, rows, properties, now);
    },

    async applyContactTopics({ tenantId, externalId, topics: wanted, source, now }) {
      const slugs = Object.keys(wanted);
      if (slugs.length === 0) return { applied: [], unknown: [] };
      const known = await db
        .select({ slug: topicsTable.slug })
        .from(topicsTable)
        .where(and(eq(topicsTable.tenantId, tenantId), inArray(topicsTable.slug, slugs)));
      const knownSet = new Set(known.map((r) => r.slug));
      const applied = slugs.filter((s) => knownSet.has(s));
      const unknown = slugs.filter((s) => !knownSet.has(s));
      if (applied.length > 0) {
        await db.transaction(async (tx) => {
          // P5b: statuses before the change, for contact.subscribed / unsubscribed.
          const contact = (
            await tx
              .select({ id: contacts.id, email: contacts.email })
              .from(contacts)
              .where(and(eq(contacts.tenantId, tenantId), eq(contacts.externalId, externalId)))
              .limit(1)
          )[0];
          const before = contact
            ? await tx
                .select({
                  topicId: topicsTable.id,
                  slug: topicsTable.slug,
                  defaultSubscribed: topicsTable.defaultSubscribed,
                  status: contactTopicsTable.status,
                })
                .from(topicsTable)
                .leftJoin(contactTopicsTable, and(eq(contactTopicsTable.topicId, topicsTable.id), eq(contactTopicsTable.contactId, contact.id)))
                .where(and(eq(topicsTable.tenantId, tenantId), inArray(topicsTable.slug, applied)))
            : [];
          for (const slug of applied) {
            await tx.execute(
              upsertContactTopicSql({
                tenantId,
                topicCondition: sql`t.slug = ${slug}`,
                contactCondition: sql`c.external_id = ${externalId}`,
                status: wanted[slug] ? "subscribed" : "unsubscribed",
                source,
                now,
              }),
            );
          }
          if (contact) {
            const entries = identifyTopicEvents(contact, before.map((b) => ({ ...b, status: b.status ?? null })), wanted, applied);
            await pgWriteOutbox(tx as unknown as PgDb, tenantId, entries, now);
          }
        });
      }
      return { applied, unknown };
    },
  };
}
