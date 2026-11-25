/**
 * Contract tests for G3 date storage: workerDates, apiIngest.syncContactDates,
 * apiConfig.reindexContactDates, and anchored enrollment (workerEnroll).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import type { EnrollableFlow } from "@claros/core";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership, insertMessage } from "./support/worker-fixtures.js";

const now = new Date("2026-11-20T12:00:00Z");
const DAY = 86_400_000;

for (const factory of testBackends()) {
  describe(`date storage on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    async function tenantWithTraits(traits: string[] = ["trial_ends_at"]) {
      const tenantId = await b.newTenant();
      await b.db.update(b.schema.tenants).set({ settings: { date_traits: traits, throttle: { tenant_timezone: "Europe/Berlin" } } }).where(eq(b.schema.tenants.id, tenantId));
      return tenantId;
    }
    const dates = (tenantId: string) => b.db.select().from(b.schema.contactDates).where(eq(b.schema.contactDates.tenantId, tenantId));

    it("syncContactDates indexes declared, parseable date traits only", async () => {
      const tenantId = await tenantWithTraits(["trial_ends_at", "first_paid_at"]);
      const contactId = await insertContact(b, tenantId, {
        externalId: "u1",
        properties: { trial_ends_at: "2026-12-01T00:00:00Z", first_paid_at: "not a date", other: "2026-01-01" },
      });
      expect(await b.store.apiIngest.syncContactDates({ tenantId, externalId: "u1", changedKeys: ["name"], now })).toBe(0);
      expect(await dates(tenantId)).toHaveLength(0);
      expect(await b.store.apiIngest.syncContactDates({ tenantId, externalId: "u1", changedKeys: ["trial_ends_at"], now })).toBe(1);
      const rows = await dates(tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0].contactId).toBe(contactId);
      expect(new Date(rows[0].value).toISOString()).toBe("2026-12-01T00:00:00.000Z");
      expect(await b.store.workerDates.getContactDate({ tenantId, contactId, property: "trial_ends_at" })).toEqual(new Date("2026-12-01T00:00:00Z"));

      // Unset: the row goes away.
      await b.db.update(b.schema.contacts).set({ properties: {} }).where(eq(b.schema.contacts.id, contactId));
      await b.store.apiIngest.syncContactDates({ tenantId, externalId: "u1", changedKeys: ["trial_ends_at"], now });
      expect(await dates(tenantId)).toHaveLength(0);
      expect(await b.store.workerDates.getContactDate({ tenantId, contactId, property: "trial_ends_at" })).toBeNull();
    });

    it("reindexContactDates rebuilds the index for the declared traits", async () => {
      const tenantId = await tenantWithTraits([]);
      for (let i = 0; i < 3; i++) await insertContact(b, tenantId, { externalId: `r${i}`, properties: { first_paid_at: 1_764_000_000 + i } });
      expect(await b.store.apiConfig.reindexContactDates({ tenantId, properties: ["first_paid_at"], now })).toBe(3);
      expect(await dates(tenantId)).toHaveLength(3);
      expect(await b.store.apiConfig.reindexContactDates({ tenantId, properties: [], now })).toBe(0);
      expect(await dates(tenantId)).toHaveLength(0);
    });

    it("lists active date flows, due candidates and stale memberships", async () => {
      const tenantId = await tenantWithTraits();
      const flowId = await insertFlow(b, tenantId, {
        triggerType: "date_property",
        triggerConfig: { property: "trial_ends_at", offset: "-3d" },
        status: "active",
        compileStatus: "ready",
        compiledPlan: { trigger: { type: "date_property", condition: {} }, steps: [] },
      });
      await insertFlow(b, tenantId, { triggerType: "event", status: "active", compileStatus: "ready", compiledPlan: {} });
      const flows = await b.store.workerDates.listActiveDateFlows(tenantId);
      expect(flows.map((f) => f.id)).toEqual([flowId]);
      expect(await b.store.workerDates.getTenantSettings(tenantId)).toMatchObject({ date_traits: ["trial_ends_at"] });
      expect((await b.store.workerDates.listTenants([tenantId])).map((t) => t.id)).toEqual([tenantId]);

      const v1 = new Date(now.getTime() + DAY);
      const c1 = await insertContact(b, tenantId, { externalId: "c1", properties: { trial_ends_at: v1.toISOString(), timezone: "Asia/Tokyo" } });
      const c2 = await insertContact(b, tenantId, { externalId: "c2", properties: { trial_ends_at: new Date(now.getTime() + 40 * DAY).toISOString() } });
      for (const ext of ["c1", "c2"]) await b.store.apiIngest.syncContactDates({ tenantId, externalId: ext, changedKeys: ["trial_ends_at"], now });

      const page = await b.store.workerDates.listDueCandidates({
        tenantId, flowId, property: "trial_ends_at", from: now, to: new Date(now.getTime() + 2 * DAY), afterContactId: null, limit: 10,
      });
      expect(page).toEqual([{ contactId: c1, value: v1, timezone: "Asia/Tokyo" }]);

      // A membership for that exact anchor removes the candidate.
      const m1 = await insertMembership(b, { tenantId, contactId: c1, flowId, anchorAt: v1, enteredAt: now });
      expect(await b.store.workerDates.listDueCandidates({
        tenantId, flowId, property: "trial_ends_at", from: now, to: new Date(now.getTime() + 2 * DAY), afterContactId: null, limit: 10,
      })).toEqual([]);
      expect(await b.store.workerDates.listStaleMemberships({ tenantId, flowId, property: "trial_ends_at", limit: 10 })).toEqual([]);

      // Moving c1's date makes the membership stale; c2's anchorless membership never is.
      await insertMembership(b, { tenantId, contactId: c2, flowId, enteredAt: now });
      await b.db.update(b.schema.contacts).set({ properties: { trial_ends_at: new Date(now.getTime() + 9 * DAY).toISOString() } }).where(eq(b.schema.contacts.id, c1));
      await b.store.apiIngest.syncContactDates({ tenantId, externalId: "c1", changedKeys: ["trial_ends_at"], now });
      expect(await b.store.workerDates.listStaleMemberships({ tenantId, flowId, property: "trial_ends_at", limit: 10 })).toEqual([{ membershipId: m1, contactId: c1 }]);
    });

    it("exitStaleMembership exits once and cancels only unsent messages", async () => {
      const tenantId = await tenantWithTraits();
      const contactId = await insertContact(b, tenantId);
      const flowId = await insertFlow(b, tenantId);
      const membershipId = await insertMembership(b, { tenantId, contactId, flowId, anchorAt: now, enteredAt: now });
      const pending = await insertMessage(b, { tenantId, contactId, flowId, membershipId, status: "pending_approval", flowStepOrder: 1 });
      const sent = await insertMessage(b, { tenantId, contactId, flowId, membershipId, status: "sent", flowStepOrder: 2 });
      const [a, c] = await Promise.all([
        b.store.workerDates.exitStaleMembership({ tenantId, membershipId, contactId, flowId, reason: "date_changed", now }),
        b.store.workerDates.exitStaleMembership({ tenantId, membershipId, contactId, flowId, reason: "date_changed", now }),
      ]);
      expect([a, c].filter(Boolean)).toHaveLength(1);
      const [m] = await b.db.select().from(b.schema.flowMemberships).where(eq(b.schema.flowMemberships.id, membershipId));
      expect(m.status).toBe("exited");
      expect(m.exitReason).toBe("date_changed");
      const msgs = await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.membershipId, membershipId));
      const byId = Object.fromEntries(msgs.map((x: any) => [x.id, x]));
      expect(byId[pending].status).toBe("cancelled");
      expect(byId[pending].statusReason).toBe("date_changed");
      expect(byId[sent].status).toBe("sent");
    });

    it("jumpMembershipStep is a CAS on the current step", async () => {
      const tenantId = await tenantWithTraits();
      const contactId = await insertContact(b, tenantId);
      const flowId = await insertFlow(b, tenantId);
      const membershipId = await insertMembership(b, { tenantId, contactId, flowId, enteredAt: now });
      const [x, y] = await Promise.all([
        b.store.workerDates.jumpMembershipStep({ membershipId, fromStep: 1, toStep: 4 }),
        b.store.workerDates.jumpMembershipStep({ membershipId, fromStep: 1, toStep: 5 }),
      ]);
      expect([x, y].filter(Boolean)).toHaveLength(1);
      expect(await b.store.workerDates.jumpMembershipStep({ membershipId, fromStep: 1, toStep: 2 })).toBe(false);
    });

    it("cancelExpiredMessages cancels unsent rows past expires_at", async () => {
      const tenantId = await tenantWithTraits();
      const contactId = await insertContact(b, tenantId);
      const flowId = await insertFlow(b, tenantId);
      const mk = async (status: string, expiresAt: Date | null, order: number) => {
        const membershipId = await insertMembership(b, { tenantId, contactId, flowId, enteredAt: now, status: "completed" });
        return insertMessage(b, { tenantId, contactId, flowId, membershipId, status, flowStepOrder: order, expiresAt });
      };
      const expired = await mk("approved", new Date(now.getTime() - 1000), 1);
      const fresh = await mk("approved", new Date(now.getTime() + 1000), 1);
      const sent = await mk("sent", new Date(now.getTime() - 1000), 1);
      const rows = await b.store.workerDates.cancelExpiredMessages({ now, limit: 100 });
      expect(rows.filter((r) => r.tenantId === tenantId).map((r) => r.id)).toEqual([expired]);
      const st = async (id: string) => (await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, id)))[0];
      expect((await st(expired)).statusReason).toBe("expired");
      expect((await st(fresh)).status).toBe("approved");
      expect((await st(sent)).status).toBe("sent");
    });

    it("anchored enrollment admits one membership per anchor value and skips re-entry", async () => {
      const tenantId = await tenantWithTraits();
      const contactId = await insertContact(b, tenantId);
      const f = { priority: 0, flowClass: "critical" as const, reentryPolicy: "once" as const, reentryCooldownDays: 30 };
      const id = await insertFlow(b, tenantId, f);
      const flow = { id, tenantId, triggerType: "date_property", triggerConfig: {}, ...f } as EnrollableFlow;
      const anchor = new Date(now.getTime() + DAY);
      const [r1, r2] = await Promise.all([
        b.store.workerEnroll.enrollContactInFlows({ contactId, tenantId, candidateFlows: [flow], now, anchorAt: anchor }),
        b.store.workerEnroll.enrollContactInFlows({ contactId, tenantId, candidateFlows: [flow], now, anchorAt: anchor }),
      ]);
      expect([r1[0], r2[0]].filter((r) => r?.enrolled)).toHaveLength(1);
      // Complete it; the same anchor is refused, a new anchor enrolls despite reentry 'once'.
      await b.db.update(b.schema.flowMemberships).set({ status: "completed", completedAt: now }).where(eq(b.schema.flowMemberships.contactId, contactId));
      const again = await b.store.workerEnroll.enrollContactInFlows({ contactId, tenantId, candidateFlows: [flow], now, anchorAt: anchor });
      expect(again[0]).toMatchObject({ enrolled: false });
      const next = await b.store.workerEnroll.enrollContactInFlows({ contactId, tenantId, candidateFlows: [flow], now, anchorAt: new Date(anchor.getTime() + DAY) });
      expect(next[0]).toMatchObject({ enrolled: true });
      const rows = await b.db.select().from(b.schema.flowMemberships).where(and(eq(b.schema.flowMemberships.contactId, contactId), eq(b.schema.flowMemberships.flowId, id)));
      expect(rows).toHaveLength(2);
    });
  });
}
