/**
 * settings.lifecycle.engagement_events through POST /v1/track and
 * POST /v1/identify: listed events count as activity, other events are
 * stored and still trigger flows, identify does not count while the list is
 * set. Requires local Postgres (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/index.js";
import { tenants, contacts, events, lifecycleTransitions } from "@claros/db/schema";
import { QUEUE } from "@claros/core";
import { openDb, newProduct, newKey, bearer, dropProduct, type TestDb, type TestProduct } from "./support/product.js";

let pool: { end(): Promise<void> };
let db: TestDb;
let p: TestProduct;
let key: string;
const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
const OLD = new Date("2026-01-01T00:00:00.000Z");

beforeAll(async () => {
  ({ pool, db } = openDb());
  p = await newProduct(db, "engagement");
  key = await newKey(db, p.tenantId, "secret");
  await db
    .update(tenants)
    .set({ settings: { lifecycle: { engagement_events: ["project_created"] } } })
    .where(eq(tenants.id, p.tenantId));
});

afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await pool.end();
});

function api() {
  return buildApp({
    db,
    logger: false,
    baseUrl: "http://localhost:3000",
    enqueue: async (queue, data) => {
      enqueued.push({ queue, data });
      return null;
    },
  });
}

async function dormantContact(externalId: string): Promise<string> {
  const [c] = await db
    .insert(contacts)
    .values({ tenantId: p.tenantId, externalId, lifecycleState: "dormant", firstSeenAt: OLD, lastSeenAt: OLD, eventCountBucketCurrent: 2 })
    .returning({ id: contacts.id });
  return c!.id;
}

async function contact(id: string) {
  const [c] = await db.select().from(contacts).where(and(eq(contacts.tenantId, p.tenantId), eq(contacts.id, id)));
  return c!;
}

async function transitions(id: string) {
  return db.select().from(lifecycleTransitions).where(and(eq(lifecycleTransitions.tenantId, p.tenantId), eq(lifecycleTransitions.contactId, id)));
}

async function eventCount(id: string) {
  return (await db.select().from(events).where(and(eq(events.tenantId, p.tenantId), eq(events.contactId, id)))).length;
}

describe("settings.lifecycle.engagement_events", () => {
  it("a listed event bumps last_seen_at and the counter and moves dormant to engaged", async () => {
    const id = await dormantContact("in-list");
    const a = await api();
    const res = await a.inject({ method: "POST", url: "/v1/track", headers: bearer(key), payload: { userId: "in-list", event: "project_created" } });
    expect(res.statusCode).toBe(200);
    const c = await contact(id);
    expect(c.lifecycleState).toBe("engaged");
    expect(c.lastSeenAt!.getTime()).toBeGreaterThan(OLD.getTime());
    expect(c.eventCountBucketCurrent).toBe(3);
    expect(await transitions(id)).toMatchObject([{ fromState: "dormant", toState: "engaged" }]);
  });

  it("an event outside the list is stored and triggers flows but is not activity", async () => {
    const id = await dormantContact("out-of-list");
    const a = await api();
    const res = await a.inject({
      method: "POST", url: "/v1/track", headers: bearer(key),
      payload: { userId: "out-of-list", event: "email_opened", properties: { k: 1 } },
    });
    expect(res.statusCode).toBe(200);
    const c = await contact(id);
    expect(c.lifecycleState).toBe("dormant");
    expect(c.lastSeenAt).toEqual(OLD);
    expect(c.eventCountBucketCurrent).toBe(2);
    expect(await transitions(id)).toEqual([]);
    expect(await eventCount(id)).toBe(1);
    expect(enqueued).toContainEqual({
      queue: QUEUE.TRIGGER_CHECK,
      data: expect.objectContaining({ tenant_id: p.tenantId, contact_id: id, event_name: "email_opened" }),
    });
  });

  it("identify updates traits but is not activity while the list is set", async () => {
    const id = await dormantContact("identify");
    const a = await api();
    const res = await a.inject({ method: "POST", url: "/v1/identify", headers: bearer(key), payload: { userId: "identify", traits: { name: "Ada" } } });
    expect(res.statusCode).toBe(200);
    const c = await contact(id);
    expect(c.name).toBe("Ada");
    expect(c.lifecycleState).toBe("dormant");
    expect(c.lastSeenAt).toEqual(OLD);
    expect(c.eventCountBucketCurrent).toBe(2);
    expect(await eventCount(id)).toBe(1);
  });
});
