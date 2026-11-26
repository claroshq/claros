/**
 * History import (G21): sent messages, events, and the lifecycle recompute.
 *
 * POST /v1/import/messages: bring a product's sent-message history
 * into Claros so throttle, re-entry, "already sent" and history conditions,
 * and kb_select exclude_used treat it like mail Claros sent.
 *
 * Auth: an owner session or an admin key with the `messages` scope.
 * Body: a JSON array of items, {"messages": [...]}, or JSONL (text/plain,
 * application/x-ndjson, application/jsonl or application/x-jsonlines):
 *   {id?, external_id? | email?, flow_slug, step_order?, action_type, subject?, sent_at, kb_external_key?}
 * Contacts resolve by external_id, else by email; flows by slug. Items are
 * idempotent by `id` when given, else by (contact, flow, step, action,
 * sent_at). ?dry_run=1 validates and resolves without writing.
 * Response: {dry_run, imported, duplicates, errors: [{index, error}]}.
 *
 * POST /v1/import/events: historical track events with their own timestamps.
 * Auth: an owner session or an admin key with the `events` scope. Same body
 * forms and limits as messages; items {id?, external_id? | email?, type?:
 * "track", event, properties?, timestamp}. `id` is stored as the messageId,
 * so live events with the same messageId and repeated imports dedupe;
 * without it a hash of (contact, event, timestamp) is used. Writes events
 * (and contacts missing by external id) only: no lifecycle transition, no
 * last_seen_at or counter change, no trigger check, enrollment, job, webhook
 * or sink. Response: {dry_run, imported, duplicates, contacts_created, errors}.
 *
 * POST /v1/import/lifecycle: after the events, recompute each contact's
 * lifecycle state, first/last seen, activated_at and engagement counters by
 * replaying its whole event history (replayLifecycle in @claros/core) under
 * the product's current lifecycle settings. Paged by contact
 * (?cursor=&limit=, next_cursor). The result is a fixed point for the scan,
 * so the next scan makes no transition; replayed transitions are stored with
 * metadata {source: "import"} and never enroll. ?dry_run=1 writes nothing
 * and reports the counts: states before and after, the retention grid, the
 * time transitions due within ?forecast_days= (default 14), and how many
 * contacts each segment-triggered flow would match (before its `where`).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  isLifecycleSegmentTriggerConfig,
  isSegmentTriggerConfig,
  recencyBucket,
  replayLifecycle,
  resolveLifecycleConfig,
  tenureBucket,
  upcomingTimeTransitions,
  type LifecycleConfig,
} from "@claros/core";
import { storeFor, type EventImportItem, type HistoryImportItem, type LifecycleReplayUpdate } from "@claros/store";
import type { Db } from "../plugins/db.js";
import { RoleRouter, allowAdminKey } from "../http/router.js";
import { JSONL_PARSERS } from "../http/body.js";

const IMPORT_BODY_LIMIT = 4 * 1024 * 1024;
export const HISTORY_IMPORT_MAX_ITEMS = 2000;

const itemSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    external_id: z.string().min(1).max(255).optional(),
    email: z.string().email().max(320).optional(),
    flow_slug: z.string().min(1).max(63),
    step_order: z.number().int().min(1).max(1000).optional(),
    action_type: z.string().min(1).max(120),
    subject: z.string().max(998).nullable().optional(),
    sent_at: z.string().datetime({ offset: true }),
    kb_external_key: z.string().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine((i) => i.external_id !== undefined || i.email !== undefined, { message: "external_id or email is required" });

const eventItemSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    external_id: z.string().min(1).max(255).optional(),
    email: z.string().email().max(320).optional(),
    type: z.literal("track").optional(),
    event: z.string().min(1).max(200),
    properties: z.record(z.unknown()).optional(),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((i) => i.external_id !== undefined || i.email !== undefined, { message: "external_id or email is required" });

/** A historical event may not be later than this past the server clock. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const lifecycleQuerySchema = z.object({
  dry_run: z.enum(["1", "true", "0", "false"]).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  forecast_days: z.coerce.number().int().min(0).max(90).optional(),
});

function items(body: unknown, key = "messages"): { items: unknown[] } | { error: string } {
  if (Array.isArray(body)) return { items: body };
  if (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>)[key])) return { items: (body as Record<string, unknown[]>)[key]! };
  if (typeof body === "string") {
    const out: unknown[] = [];
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        return { error: `line ${i + 1}: not valid JSON` };
      }
    }
    return { items: out };
  }
  return { error: `Send a JSON array, {"${key}": [...]}, or JSONL (text/plain or application/x-ndjson).` };
}

export default function importRoutes() {
  const r = new RoleRouter({ limit: IMPORT_BODY_LIMIT, parsers: JSONL_PARSERS });

  r.post("/messages", "owner", allowAdminKey("messages"), async (c) => {
    const parsed = items(c.var.body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    if (parsed.items.length > HISTORY_IMPORT_MAX_ITEMS) {
      return c.json({ error: `At most ${HISTORY_IMPORT_MAX_ITEMS} messages per request; split the file.` }, 400);
    }
    const dryRun = ["1", "true"].includes(c.req.query("dry_run") ?? "");
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const errors: Array<{ index: number; error: string }> = [];
    const valid: HistoryImportItem[] = [];
    parsed.items.forEach((raw, index) => {
      const v = itemSchema.safeParse(raw);
      if (!v.success) {
        errors.push({ index, error: v.error.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; ") });
        return;
      }
      const i = v.data;
      const sentAt = new Date(i.sent_at);
      const stepOrder = i.step_order ?? 1;
      const who = i.external_id ? `ext:${i.external_id}` : `email:${i.email!.toLowerCase()}`;
      const importKey = i.id
        ? `id:${i.id}`
        : `h:${createHash("sha256").update(JSON.stringify([who, i.flow_slug, stepOrder, i.action_type, sentAt.toISOString()])).digest("hex").slice(0, 40)}`;
      valid.push({
        index,
        externalId: i.external_id ?? null,
        email: i.email ?? null,
        flowSlug: i.flow_slug,
        stepOrder,
        actionType: i.action_type,
        subject: i.subject ?? null,
        sentAt,
        kbExternalKey: i.kb_external_key ?? null,
        importKey,
      });
    });
    const result = await storeFor(db).apiImport.importMessages({ tenantId, items: valid, dryRun, now: new Date() });
    return c.json({
      dry_run: dryRun,
      imported: result.imported,
      duplicates: result.duplicates,
      errors: [...errors, ...result.errors].sort((a, b) => a.index - b.index),
    });
  });

  r.post("/events", "owner", allowAdminKey("events"), async (c) => {
    const parsed = items(c.var.body, "events");
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    if (parsed.items.length > HISTORY_IMPORT_MAX_ITEMS) {
      return c.json({ error: `At most ${HISTORY_IMPORT_MAX_ITEMS} events per request; split the file.` }, 400);
    }
    const dryRun = ["1", "true"].includes(c.req.query("dry_run") ?? "");
    const now = new Date();
    const errors: Array<{ index: number; error: string }> = [];
    const valid: EventImportItem[] = [];
    parsed.items.forEach((raw, index) => {
      const v = eventItemSchema.safeParse(raw);
      if (!v.success) {
        errors.push({ index, error: v.error.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; ") });
        return;
      }
      const i = v.data;
      const timestamp = new Date(i.timestamp);
      if (timestamp.getTime() > now.getTime() + FUTURE_SKEW_MS) {
        errors.push({ index, error: "timestamp: in the future" });
        return;
      }
      const who = i.external_id ? `ext:${i.external_id}` : `email:${i.email!.toLowerCase()}`;
      valid.push({
        index,
        externalId: i.external_id ?? null,
        email: i.email ?? null,
        eventName: i.event,
        properties: i.properties ?? null,
        timestamp,
        messageId: i.id ?? `import:${createHash("sha256").update(JSON.stringify([who, i.event, timestamp.toISOString()])).digest("hex").slice(0, 40)}`,
      });
    });
    const result = await storeFor(c.var.db).apiImport.importEvents({ tenantId: c.var.tenant!.id, items: valid, dryRun, now });
    return c.json({
      dry_run: dryRun,
      imported: result.imported,
      duplicates: result.duplicates,
      contacts_created: result.contactsCreated,
      errors: [...errors, ...result.errors].sort((a, b) => a.index - b.index),
    });
  });

  r.post("/lifecycle", "owner", allowAdminKey("events"), async (c) => {
    const q = lifecycleQuerySchema.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    const dryRun = q.data.dry_run === "1" || q.data.dry_run === "true";
    const limit = q.data.limit ?? 200;
    const forecastDays = q.data.forecast_days ?? 14;
    const tenantId = c.var.tenant!.id;
    const store = storeFor(c.var.db);
    const now = new Date();
    const until = new Date(now.getTime() + forecastDays * 86_400_000);

    const settings = (await store.apiAnalytics.getTenantSettings({ tenantId })) as Record<string, unknown> | null | undefined;
    const config: LifecycleConfig = resolveLifecycleConfig(settings?.lifecycle as Partial<LifecycleConfig> | null | undefined);
    const page = await store.apiImport.listLifecycleReplayPage({ tenantId, afterContactId: q.data.cursor ?? null, limit });
    const segmentFlows = await store.apiImport.listSegmentFlows(tenantId);

    const statesBefore: Record<string, number> = {};
    const states: Record<string, number> = {};
    const upcoming: Record<string, number> = {};
    const grid: Record<string, number> = {};
    const segmentMatches = segmentFlows.map(() => 0);
    const updates: LifecycleReplayUpdate[] = [];
    let transitions = 0;
    const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

    for (const contact of page) {
      bump(statesBefore, contact.lifecycleState);
      const r = replayLifecycle(contact.events, config, now, contact.lastCounterResetAt);
      const state = r?.state ?? contact.lifecycleState;
      const firstSeenAt = r?.firstSeenAt ?? contact.firstSeenAt;
      const lastSeenAt = r?.lastSeenAt ?? contact.lastSeenAt;
      bump(states, state);
      if (firstSeenAt && lastSeenAt) {
        bump(grid, `${tenureBucket(firstSeenAt, now)}/${recencyBucket(lastSeenAt, now, config.natural_frequency_days)}`);
        for (const t of upcomingTimeTransitions(state, lastSeenAt, config, now, until)) bump(upcoming, t.to);
      }
      segmentFlows.forEach((f, k) => {
        const cfg = f.triggerConfig;
        if (isSegmentTriggerConfig(cfg)) {
          if (firstSeenAt && lastSeenAt && cfg.tenure_bucket === tenureBucket(firstSeenAt, now) && cfg.recency_bucket === recencyBucket(lastSeenAt, now, config.natural_frequency_days)) segmentMatches[k]!++;
        } else if (isLifecycleSegmentTriggerConfig(cfg)) {
          const stateOk = !cfg.lifecycle_states || cfg.lifecycle_states.includes(state);
          const depthOk = !cfg.engagement_depths || (contact.engagementDepth !== null && cfg.engagement_depths.includes(contact.engagementDepth));
          if (stateOk && depthOk) segmentMatches[k]!++;
        }
      });
      if (!r) continue;
      const same =
        r.state === contact.lifecycleState &&
        r.firstSeenAt.getTime() === contact.firstSeenAt?.getTime() &&
        r.lastSeenAt.getTime() === contact.lastSeenAt?.getTime() &&
        (r.activatedAt?.getTime() ?? null) === (contact.activatedAt?.getTime() ?? null) &&
        r.counters.current === contact.eventCountBucketCurrent &&
        r.counters.prev === contact.eventCountBucketPrev;
      if (same) continue;
      transitions += r.transitions.length;
      updates.push({
        contactId: contact.id,
        expected: { state: contact.lifecycleState, lastSeenAt: contact.lastSeenAt },
        state: r.state,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        activatedAt: r.activatedAt,
        counters: r.counters,
        transitions: r.transitions.map((t) => ({ from: t.from, to: t.to, at: t.at, trigger: t.trigger })),
      });
    }

    const written = dryRun ? { applied: 0, skipped: 0 } : await store.apiImport.applyLifecycleReplay({ tenantId, updates });
    return c.json({
      dry_run: dryRun,
      contacts: page.length,
      changed: updates.length,
      applied: written.applied,
      skipped: written.skipped,
      transitions,
      states_before: statesBefore,
      states,
      upcoming: { days: forecastDays, to: upcoming },
      grid,
      segment_flows: segmentFlows.map((f, k) => ({ slug: f.slug, name: f.name, status: f.status, matching: segmentMatches[k] })),
      next_cursor: page.length === limit ? page[page.length - 1]!.id : null,
    });
  });

  return r.app;
}
