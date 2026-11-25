/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-ingest.ts.
 *
 * Postgres runs the ingest path as one interactive transaction behind an
 * advisory lock on (tenant, messageId). D1 has neither, so each method is:
 *
 * 1. One read batch: is the messageId already stored, the contact's current
 *    lifecycle state, the tenant's lifecycle config (and, for a signed_up
 *    contact on an activation event, its distinct activation event names).
 *    The transition is decided in JS from these (../shared/api-ingest.ts).
 * 2. One write batch (a single SQLite transaction; D1 serialises writes):
 *    - contact upsert and event insert, each guarded by
 *      `NOT EXISTS (event with this messageId)`. The event id is generated
 *      here, so every later statement is guarded by "our event row exists":
 *      a duplicate (even one that raced past step 1) writes nothing at all.
 *    - identify: conflict rows, email update guarded by "no other contact
 *      holds this email" (the conflict row uses the inverse guard, so no
 *      unique violation and no retry is needed), the other columns and the
 *      properties merge in one UPDATE.
 *    - lifecycle transition: audit row and CAS update, both guarded by
 *      `lifecycle_state = <from>`, audit row first so it is written only
 *      when the CAS applies.
 *
 * Properties merge: Postgres uses `(props - removed) || merged` (top-level,
 * null values kept). SQLite's json_patch drops null members (RFC 7396), so
 * the merge is rebuilt with json_each/json_group_object in the UPDATE itself
 * (atomic, no read-modify-write in JS) and keeps nulls like jsonb `||`.
 *
 * Difference under concurrency: the transition is decided from the state
 * read in step 1. If another request changes the contact's state between the
 * read and the write batch, the CAS guard makes this request write no
 * transition (Postgres would decide from the state it read inside its
 * transaction). The other request's transition stands; nothing is written
 * twice.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { contacts, events, tenants } from "@claros/db/schema-sqlite";
import type { LifecycleState } from "@claros/core";
import type { D1Db } from "./db.js";
import type { ApiIngestQueries, IngestTraitPlan } from "../areas/api-ingest.js";
import {
  activationEventsToRead,
  lifecycleConfigFromSettings,
  planIngestTransition,
  type IngestTransitionPlan,
} from "../shared/api-ingest.js";
import { topics as topicsTable } from "@claros/db/schema-sqlite";
import { upsertContactTopicSql } from "./contact-topics.js";
import { rawBatch as rawBatchShared } from "./raw-batch.js";

interface IngestEventInput {
  tenantId: string;
  userId: string;
  type: "track" | "identify";
  eventName: string | null;
  properties: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  messageId: string | undefined;
  timestamp: Date;
  now: Date;
  /** identify only: partitioned traits (null = only ensure the contact). */
  traitPlan: IngestTraitPlan | null;
}

type IngestResult = { deduplicated: true } | { deduplicated: false; contactId: string };

const dialect = new SQLiteAsyncDialect();

/** The D1 binding behind the Drizzle handle (the parts used here). */
interface D1Binding {
  prepare(query: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<Array<{ results?: unknown[] }>>;
}

/**
 * Run raw SQL statements as one D1 batch (one SQLite transaction) and return
 * each statement's rows. Drizzle 0.45 cannot batch raw `sql` on D1
 * (SQLiteRaw has no prepared statement), so this goes to the binding.
 */
async function rawBatch(db: D1Db, queries: SQL[]): Promise<Array<Array<Record<string, unknown>>>> {
  const client = (db as unknown as { $client: D1Binding }).$client;
  const statements = queries.map((q) => {
    const { sql: text, params } = dialect.sqlToQuery(q);
    return client.prepare(text).bind(...params);
  });
  const results = await client.batch(statements);
  return results.map((r) => (r.results ?? []) as Array<Record<string, unknown>>);
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * Step 1: dedup pre-check, current lifecycle state and the transition plan.
 * Returns null when the messageId is already stored.
 */
async function planEvent(
  db: D1Db,
  input: IngestEventInput,
): Promise<{ currentState: LifecycleState; transition: IngestTransitionPlan | null } | null> {
  const { tenantId, userId, messageId } = input;
  const contactQuery = db
    .select({ id: contacts.id, lifecycleState: contacts.lifecycleState })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.externalId, userId)))
    .limit(1);
  const settingsQuery = db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  let contactRows: Array<{ id: string; lifecycleState: string }>;
  let tenantRows: Array<{ settings: unknown }>;
  if (messageId) {
    // Fast path for retries; the write batch re-checks under its own guard.
    const [dup, c, t] = await db.batch([
      db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.tenantId, tenantId), eq(events.messageId, messageId)))
        .limit(1),
      contactQuery,
      settingsQuery,
    ]);
    if (dup.length > 0) return null;
    contactRows = c;
    tenantRows = t;
  } else {
    [contactRows, tenantRows] = await db.batch([contactQuery, settingsQuery]);
  }

  const contact = contactRows[0];
  // A contact created by this event starts in signed_up (ensureContact in pg).
  const currentState = (contact?.lifecycleState ?? "signed_up") as LifecycleState;
  const config = lifecycleConfigFromSettings(tenantRows[0]?.settings);

  const namesToRead = activationEventsToRead(currentState, input.eventName, config);
  let priorEventNames: string[] = [];
  if (contact && namesToRead.length > 0) {
    const rows = await db
      .selectDistinct({ eventName: events.eventName })
      .from(events)
      .where(
        and(
          eq(events.contactId, contact.id),
          eq(events.type, "track"),
          inArray(events.eventName, namesToRead),
        ),
      );
    priorEventNames = rows.map((r) => r.eventName).filter((n): n is string => n !== null);
  }

  const transition = planIngestTransition({
    currentState,
    eventName: input.eventName,
    config,
    priorEventNames,
  });
  return { currentState, transition };
}

/** Properties merge expression with jsonb `(props - removed) || merged` semantics. */
function mergedPropertiesSql(propsToMerge: Record<string, unknown>, keysToRemove: string[]): SQL {
  const mergeJson = JSON.stringify(propsToMerge);
  const removeJson = JSON.stringify(keysToRemove);
  return sql`(
    SELECT json_group_object(
      key,
      CASE type
        WHEN 'object' THEN json(value)
        WHEN 'array' THEN json(value)
        WHEN 'true' THEN json('true')
        WHEN 'false' THEN json('false')
        WHEN 'null' THEN json('null')
        ELSE value
      END
    )
    FROM (
      SELECT key, type, value FROM json_each(COALESCE(contacts.properties, '{}'))
      WHERE key NOT IN (SELECT value FROM json_each(${removeJson}))
        AND key NOT IN (SELECT key FROM json_each(${mergeJson}))
      UNION ALL
      SELECT key, type, value FROM json_each(${mergeJson})
    )
  )`;
}

/** Step 2: the guarded write batch. */
async function writeEvent(
  db: D1Db,
  input: IngestEventInput,
  transition: IngestTransitionPlan | null,
): Promise<IngestResult> {
  const { tenantId, userId, messageId, now } = input;
  const nowMs = now.getTime();
  const eventId = crypto.randomUUID();

  const notYetStored = messageId
    ? sql`NOT EXISTS (SELECT 1 FROM events WHERE tenant_id = ${tenantId} AND message_id = ${messageId})`
    : sql`1`;
  const ourEventStored = sql`EXISTS (SELECT 1 FROM events WHERE tenant_id = ${tenantId} AND id = ${eventId})`;
  const contactRef = sql`(SELECT id FROM contacts WHERE tenant_id = ${tenantId} AND external_id = ${userId})`;
  const ourContact = sql`tenant_id = ${tenantId} AND external_id = ${userId}`;

  const upsertContact = sql`
    INSERT INTO contacts (
      id, tenant_id, external_id, lifecycle_state, first_seen_at, last_seen_at,
      event_count_bucket_current, created_at
    )
    SELECT ${crypto.randomUUID()}, ${tenantId}, ${userId}, 'signed_up', ${nowMs}, ${nowMs}, 1, ${nowMs}
    WHERE ${notYetStored}
    ON CONFLICT (tenant_id, external_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      event_count_bucket_current = COALESCE(contacts.event_count_bucket_current, 0) + 1
    RETURNING id, lifecycle_state
  `;

  const insertEvent = sql`
    INSERT INTO events (
      id, tenant_id, contact_id, type, event_name, properties, context, message_id,
      timestamp, received_at
    )
    SELECT ${eventId}, ${tenantId}, ${contactRef}, ${input.type}, ${input.eventName},
      ${jsonOrNull(input.properties)}, ${jsonOrNull(input.context)}, ${messageId ?? null},
      ${input.timestamp.getTime()}, ${nowMs}
    WHERE ${notYetStored}
    RETURNING id
  `;

  const rest: SQL[] = [];

  const plan = input.type === "identify" ? input.traitPlan : null;
  if (plan) {
    const { columnUpdates, propsToMerge, keysToRemove } = plan;
    const insertConflict = (field: string, rejectedValue: string, guard: SQL) =>
      sql`
        INSERT INTO contact_conflicts (id, tenant_id, contact_id, field, rejected_value, event_id, created_at)
        SELECT ${crypto.randomUUID()}, ${tenantId}, ${contactRef}, ${field}, ${rejectedValue}, ${eventId}, ${nowMs}
        WHERE ${ourEventStored} AND ${guard}
      `;

    for (const c of plan.conflicts) rest.push(insertConflict(c.field, c.rejectedValue, sql`1`));

    if ("email" in columnUpdates) {
      const email = columnUpdates.email;
      if (email !== null && email !== undefined) {
        const emailTaken = sql`EXISTS (
          SELECT 1 FROM contacts other
          WHERE other.tenant_id = ${tenantId} AND other.email = ${email} AND other.external_id <> ${userId}
        )`;
        // Conflict row first: it sees the same ownership the update below checks.
        rest.push(insertConflict("email", email, emailTaken));
        rest.push(sql`UPDATE contacts SET email = ${email} WHERE ${ourContact} AND ${ourEventStored} AND NOT ${emailTaken}`);
      } else if (email === null) {
        rest.push(sql`UPDATE contacts SET email = NULL WHERE ${ourContact} AND ${ourEventStored}`);
      }
    }

    const sets: SQL[] = [];
    if ("name" in columnUpdates) sets.push(sql`name = ${columnUpdates.name ?? null}`);
    if ("company" in columnUpdates) sets.push(sql`company = ${columnUpdates.company ?? null}`);
    if ("paymentStatus" in columnUpdates) sets.push(sql`payment_status = ${columnUpdates.paymentStatus ?? null}`);
    if (Object.keys(propsToMerge).length > 0 || keysToRemove.length > 0) {
      sets.push(sql`properties = ${mergedPropertiesSql(propsToMerge, keysToRemove)}`);
    }
    if (sets.length > 0) {
      rest.push(sql`UPDATE contacts SET ${sql.join(sets, sql`, `)} WHERE ${ourContact} AND ${ourEventStored}`);
    }
  }

  if (transition) {
    const inFromState = sql`lifecycle_state = ${transition.from}`;
    // Audit row before the CAS: both see the pre-transition state.
    rest.push(sql`
        INSERT INTO lifecycle_transitions (
          id, tenant_id, contact_id, from_state, to_state, trigger_event_id, metadata, transitioned_at
        )
        SELECT ${crypto.randomUUID()}, ${tenantId}, id, ${transition.from}, ${transition.to}, ${eventId}, NULL, ${nowMs}
        FROM contacts
        WHERE ${ourContact} AND ${inFromState} AND ${ourEventStored}
      `);
    const activatedAt = transition.setActivatedAt
      ? sql`, activated_at = COALESCE(activated_at, ${nowMs})`
      : sql``;
    rest.push(sql`
      UPDATE contacts SET lifecycle_state = ${transition.to}${activatedAt}
      WHERE ${ourContact} AND ${inFromState} AND ${ourEventStored}
    `);
  }

  const [contactRows, eventRows] = await rawBatch(db, [upsertContact, insertEvent, ...rest]);
  if (eventRows!.length === 0) return { deduplicated: true };
  return { deduplicated: false, contactId: contactRows![0]!.id as string };
}

async function recordEvent(db: D1Db, input: IngestEventInput): Promise<IngestResult> {
  const planned = await planEvent(db, input);
  if (planned === null) return { deduplicated: true };
  return writeEvent(db, input, planned.transition);
}

export function d1ApiIngest(db: D1Db): ApiIngestQueries {
  return {
    async recordTrackEvent(input) {
      return recordEvent(db, {
        tenantId: input.tenantId,
        userId: input.userId,
        type: "track",
        eventName: input.eventName,
        properties: input.properties,
        context: input.context,
        messageId: input.messageId,
        timestamp: input.timestamp,
        now: input.now,
        traitPlan: null,
      });
    },

    async recordIdentifyEvent(input) {
      const result = await recordEvent(db, {
        tenantId: input.tenantId,
        userId: input.userId,
        type: "identify",
        eventName: null,
        properties: input.traits,
        context: input.context,
        messageId: input.messageId,
        timestamp: input.timestamp,
        now: input.now,
        traitPlan: input.traitPlan,
      });
      return { deduplicated: result.deduplicated };
    },

    async applyContactTopics({ tenantId, externalId, topics: wanted, source, now }) {
      const slugs = Object.keys(wanted);
      if (slugs.length === 0) return { applied: [], unknown: [] };
      const knownSet = new Set<string>();
      // D1 allows at most 100 bound parameters per statement.
      for (let i = 0; i < slugs.length; i += 90) {
        const chunk = slugs.slice(i, i + 90);
        const rows = await db
          .select({ slug: topicsTable.slug })
          .from(topicsTable)
          .where(and(eq(topicsTable.tenantId, tenantId), inArray(topicsTable.slug, chunk)));
        for (const r of rows) knownSet.add(r.slug);
      }
      const applied = slugs.filter((s) => knownSet.has(s));
      const unknown = slugs.filter((s) => !knownSet.has(s));
      if (applied.length > 0) {
        await rawBatchShared(
          db,
          applied.map((slug) =>
            upsertContactTopicSql({
              tenantId,
              topicCondition: sql`t.slug = ${slug}`,
              contactCondition: sql`c.external_id = ${externalId}`,
              status: wanted[slug] ? "subscribed" : "unsubscribed",
              source,
              now,
            }),
          ),
        );
      }
      return { applied, unknown };
    },
  };
}
