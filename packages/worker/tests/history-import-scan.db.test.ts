/**
 * History import and the scan (Postgres): after events are imported and the
 * lifecycle replay is applied (what POST /v1/import/lifecycle does), the next
 * scan's time-transition phase finds nothing to do, so no transition-triggered
 * flow (winback on -> churned) can enroll anyone from the import.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { tenants, contacts } from "@claros/db/schema";
import { storeFor, type EventImportItem } from "@claros/store";
import { replayLifecycle, resolveLifecycleConfig } from "@claros/core";
import { phaseTimeTransitions } from "../src/scan-time-transitions.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[history-import-scan.test] DATABASE_URL is not set.");

const SLUG = "test-history-import-scan";
const lifecycle = { activation_events: ["activated"], engagement_events: ["active_day", "activated"], natural_frequency_days: 7, at_risk_missed_intervals: 2, dormant_days: 30, churned_days: 45 };
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let tenantId: string;

async function cleanup() {
  for (const table of ["lifecycle_transitions", "events", "contacts"]) {
    await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  }
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL });
  db = drizzle(pool);
  await cleanup();
  const [t] = await db.insert(tenants).values({ name: "History import scan", slug: SLUG, settings: { lifecycle } }).returning({ id: tenants.id });
  tenantId = t!.id;
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("history import then scan", () => {
  it("the scan right after the recompute applies no transition", async () => {
    const store = storeFor(db);
    const now = new Date();
    const DAY = 86_400_000;
    const rnd = mulberry32(11);
    const items: EventImportItem[] = [];
    for (let c = 0; c < 40; c++) {
      const ext = `user-${c}`;
      let d = 170 + rnd() * 10;
      const push = (eventName: string) => items.push({ index: items.length, externalId: ext, email: null, eventName, properties: null, timestamp: new Date(now.getTime() - d * DAY), messageId: `${eventName}:${ext}:${items.length}` });
      push("signed_up");
      if (rnd() < 0.85) {
        d -= rnd() * 5;
        push("activated");
      }
      while (d > 0.5) {
        d -= rnd() < 0.6 ? 0.5 + rnd() * 3 : 10 + rnd() * 50;
        if (d > 0.1) push("active_day");
      }
    }
    for (let i = 0; i < items.length; i += 2000) {
      await store.apiImport.importEvents({ tenantId, items: items.slice(i, i + 2000), dryRun: false, now });
    }

    const config = resolveLifecycleConfig(lifecycle);
    const page = await store.apiImport.listLifecycleReplayPage({ tenantId, afterContactId: null, limit: 500 });
    expect(page).toHaveLength(40);
    const updates = page.map((c) => {
      const r = replayLifecycle(c.events, config, now, c.lastCounterResetAt)!;
      return {
        contactId: c.id,
        expected: { state: c.lifecycleState, lastSeenAt: c.lastSeenAt },
        state: r.state,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        activatedAt: r.activatedAt,
        counters: r.counters,
        transitions: r.transitions,
      };
    });
    expect(await store.apiImport.applyLifecycleReplay({ tenantId, updates })).toEqual({ applied: 40, skipped: 0 });
    const states = new Set((await db.select({ s: contacts.lifecycleState }).from(contacts).where(eq(contacts.tenantId, tenantId))).map((r) => r.s));
    expect(states.size).toBeGreaterThan(2);

    const scan = await phaseTimeTransitions(db, new Date(now.getTime() + 60_000), [tenantId]);
    expect(scan.contactsEvaluated).toBeGreaterThan(0);
    expect(scan.transitionsApplied).toBe(0);
    expect(scan.appliedTransitions).toEqual([]);
  });
});
