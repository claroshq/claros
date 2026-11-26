/**
 * Contract tests for apiImport.importEvents and the lifecycle replay queries
 * (history import): resolution and creation of contacts, messageId dedup
 * shared with live ingest, dry run, that importing writes only events (and
 * missing contacts), and the compare-and-set replay write.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { EventImportItem } from "../src/index.js";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow } from "./support/worker-fixtures.js";

const NOW = new Date("2026-11-26T20:00:00Z");
const day = (d: number) => new Date(Date.UTC(2026, 5, 1) + d * 86_400_000);

function item(index: number, over: Partial<EventImportItem> = {}): EventImportItem {
  return {
    index,
    externalId: "u-1",
    email: null,
    eventName: "active_day",
    properties: { date: "2026-06-01" },
    timestamp: day(0),
    messageId: `m${index}`,
    ...over,
  };
}

for (const factory of testBackends()) {
  describe(`apiImport events on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const contactRow = async (tenantId: string, externalId: string) =>
      (await b.db.select().from(b.schema.contacts).where(and(eq(b.schema.contacts.tenantId, tenantId), eq(b.schema.contacts.externalId, externalId))))[0];

    it("imports events once, by external id or email, and creates missing contacts", async () => {
      const tenantId = await b.newTenant();
      const seenAt = new Date("2026-11-26T19:00:00Z");
      const c1 = await insertContact(b, tenantId, { externalId: "u-1", email: "one@example.com", firstSeenAt: seenAt, lastSeenAt: seenAt, eventCountBucketCurrent: 1 });
      const items = [
        item(0),
        item(1, { externalId: null, email: "ONE@example.com", timestamp: day(1) }),
        item(2, { externalId: "u-new", timestamp: day(5) }),
        item(3, { externalId: "u-new", timestamp: day(3) }),
        item(4, { externalId: null, email: "nobody@example.com" }),
        item(5, { messageId: "m0" }),
      ];
      const dry = await b.store.apiImport.importEvents({ tenantId, items, dryRun: true, now: NOW });
      expect(dry).toMatchObject({ imported: 4, duplicates: 1, contactsCreated: 1 });
      expect(dry.errors.map((e) => e.index)).toEqual([4]);
      expect(await b.db.select().from(b.schema.events).where(eq(b.schema.events.tenantId, tenantId))).toHaveLength(0);
      expect(await contactRow(tenantId, "u-new")).toBeUndefined();

      const r = await b.store.apiImport.importEvents({ tenantId, items, dryRun: false, now: NOW });
      expect(r).toMatchObject({ imported: 4, duplicates: 1, contactsCreated: 1 });
      const again = await b.store.apiImport.importEvents({ tenantId, items: items.slice(0, 4), dryRun: false, now: NOW });
      expect(again).toMatchObject({ imported: 0, duplicates: 4, contactsCreated: 0 });

      const evs = await b.db.select().from(b.schema.events).where(eq(b.schema.events.tenantId, tenantId));
      expect(evs).toHaveLength(4);
      expect(evs.filter((e: any) => e.contactId === c1)).toHaveLength(2);
      const e0 = evs.find((e: any) => e.messageId === "m0");
      expect(new Date(e0.timestamp).getTime()).toBe(day(0).getTime());
      expect(new Date(e0.receivedAt).getTime()).toBe(NOW.getTime());
      expect(e0.context).toEqual({ source: "import" });

      // The existing contact is untouched: lifecycle fields stay for the recompute.
      const existing = await contactRow(tenantId, "u-1");
      expect(existing.lifecycleState).toBe("signed_up");
      expect(new Date(existing.lastSeenAt).getTime()).toBe(seenAt.getTime());
      expect(existing.eventCountBucketCurrent).toBe(1);
      const created = await contactRow(tenantId, "u-new");
      expect(created).toMatchObject({ lifecycleState: "signed_up", email: null });
      expect(new Date(created.firstSeenAt).getTime()).toBe(day(3).getTime());

      // No transitions, memberships, messages or webhook rows.
      for (const t of [b.schema.lifecycleTransitions, b.schema.flowMemberships, b.schema.lifecycleMessages, b.schema.webhookOutbox]) {
        expect(await b.db.select().from(t).where(eq(t.tenantId, tenantId))).toHaveLength(0);
      }
    });

    it("shares the messageId with live ingest (either side stores it once)", async () => {
      const tenantId = await b.newTenant();
      await b.store.apiIngest.recordTrackEvent({ tenantId, userId: "u-1", eventName: "activated", properties: null, context: null, messageId: "activated:u-1", timestamp: NOW, now: NOW });
      const r = await b.store.apiImport.importEvents({
        tenantId,
        items: [item(0, { eventName: "activated", messageId: "activated:u-1" }), item(1, { messageId: "active_day:u-1:2026-06-01" })],
        dryRun: false,
        now: NOW,
      });
      expect(r).toMatchObject({ imported: 1, duplicates: 1 });
      const live = await b.store.apiIngest.recordTrackEvent({ tenantId, userId: "u-1", eventName: "active_day", properties: null, context: null, messageId: "active_day:u-1:2026-06-01", timestamp: NOW, now: NOW });
      expect(live).toEqual({ deduplicated: true });
    });

    it("pages contacts with their history and applies the replay with compare-and-set", async () => {
      const tenantId = await b.newTenant();
      const flowId = await insertFlow(b, tenantId, { slug: "winback", triggerType: "lifecycle_transition", triggerConfig: { type: "lifecycle_transition", to: "churned" } });
      expect(flowId).toBeTruthy();
      const seed = new Date("2026-11-26T19:00:00Z");
      const ids: string[] = [];
      for (const ext of ["a", "b", "c"]) ids.push(await insertContact(b, tenantId, { externalId: ext, firstSeenAt: seed, lastSeenAt: seed }));
      await b.store.apiImport.importEvents({
        tenantId,
        items: ["a", "b", "c"].flatMap((ext, k) => [item(k * 2, { externalId: ext, messageId: `${ext}:1`, timestamp: day(2) }), item(k * 2 + 1, { externalId: ext, messageId: `${ext}:0`, timestamp: day(1) })]),
        dryRun: false,
        now: NOW,
      });

      const p1 = await b.store.apiImport.listLifecycleReplayPage({ tenantId, afterContactId: null, limit: 2 });
      const p2 = await b.store.apiImport.listLifecycleReplayPage({ tenantId, afterContactId: p1[1]!.id, limit: 2 });
      expect([...p1, ...p2].map((c) => c.id)).toEqual([...ids].sort());
      expect(await b.store.apiImport.listLifecycleReplayPage({ tenantId, afterContactId: p2[0]!.id, limit: 2 })).toEqual([]);
      const first = p1[0]!;
      expect(first.events.map((e) => e.timestamp.getTime())).toEqual([day(1).getTime(), day(2).getTime()]);
      expect(first.lifecycleState).toBe("signed_up");
      expect(first.lastSeenAt!.getTime()).toBe(seed.getTime());

      const update = (c: (typeof p1)[number], expectedState = c.lifecycleState) => ({
        contactId: c.id,
        expected: { state: expectedState, lastSeenAt: c.lastSeenAt },
        state: "churned" as const,
        firstSeenAt: day(1),
        lastSeenAt: day(2),
        activatedAt: day(1),
        counters: { current: 0, prev: 0, resetAt: NOW },
        transitions: [
          { from: "signed_up" as const, to: "activated" as const, at: day(1), trigger: "event" as const },
          { from: "dormant" as const, to: "churned" as const, at: day(47), trigger: "time" as const },
        ],
      });
      const res = await b.store.apiImport.applyLifecycleReplay({ tenantId, updates: [update(p1[0]!), update(p1[1]!, "engaged")] });
      expect(res).toEqual({ applied: 1, skipped: 1 });
      const a = (await b.db.select().from(b.schema.contacts).where(eq(b.schema.contacts.id, p1[0]!.id)))[0];
      expect(a.lifecycleState).toBe("churned");
      expect(new Date(a.lastSeenAt).getTime()).toBe(day(2).getTime());
      expect(new Date(a.activatedAt).getTime()).toBe(day(1).getTime());
      const skipped = (await b.db.select().from(b.schema.contacts).where(eq(b.schema.contacts.id, p1[1]!.id)))[0];
      expect(skipped.lifecycleState).toBe("signed_up");

      // A live transition stays; import transitions are replaced on a re-run.
      await b.db.insert(b.schema.lifecycleTransitions).values({ tenantId, contactId: p1[0]!.id, fromState: "signed_up", toState: "activated", transitionedAt: NOW, ...(factory.name === "d1" ? { id: crypto.randomUUID() } : {}) });
      const again = await b.store.apiImport.listLifecycleReplayPage({ tenantId, afterContactId: null, limit: 1 });
      expect(await b.store.apiImport.applyLifecycleReplay({ tenantId, updates: [update(again[0]!)] })).toEqual({ applied: 1, skipped: 0 });
      const ts = await b.db.select().from(b.schema.lifecycleTransitions).where(eq(b.schema.lifecycleTransitions.contactId, p1[0]!.id));
      expect(ts).toHaveLength(3);
      expect(ts.filter((t: any) => t.metadata?.source === "import").map((t: any) => t.metadata.trigger).sort()).toEqual(["event", "time"]);

      // The replay never enrolls: no membership for the churned contact.
      expect(await b.db.select().from(b.schema.flowMemberships).where(eq(b.schema.flowMemberships.tenantId, tenantId))).toHaveLength(0);
    });

    it("lists segment flows with their status", async () => {
      const tenantId = await b.newTenant();
      await insertFlow(b, tenantId, { slug: "nurture", triggerType: "segment", triggerConfig: { lifecycle_states: ["dormant"] }, status: "paused" });
      await insertFlow(b, tenantId, { slug: "welcome" });
      const flows = await b.store.apiImport.listSegmentFlows(tenantId);
      expect(flows).toEqual([{ slug: "nurture", name: expect.any(String), status: "paused", triggerConfig: { lifecycle_states: ["dormant"] } }]);
    });
  });
}
