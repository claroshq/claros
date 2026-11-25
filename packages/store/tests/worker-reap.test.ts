/**
 * Contract tests for the workerReap store area (packages/worker/src/reap.ts).
 *
 * Fixtures use updated_at in the year 2000 and a threshold just after it, so the
 * unscoped (all tenants) calls cannot touch rows of other suites sharing the
 * Postgres database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";
import { getMessage, seedMessage, sorted } from "./support/send-path-fixtures.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const OLD = new Date("2000-01-01T00:00:00.000Z");
const THRESHOLD = new Date("2000-01-01T00:00:01.000Z");

for (const factory of testBackends()) {
  describe(`workerReap on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("retryStuckMessages resets stuck messages below the retry cap and bumps retry_count", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const stuck = await seedMessage(b, { tenantId: t, status: "sending", updatedAt: OLD, retryCount: 0 });
      const stuck2 = await seedMessage(b, { tenantId: t, status: "sending", updatedAt: OLD, retryCount: 2 });
      const atCap = await seedMessage(b, { tenantId: t, status: "sending", updatedAt: OLD, retryCount: 3 });
      const fresh = await seedMessage(b, { tenantId: t, status: "sending", updatedAt: THRESHOLD, retryCount: 0 });
      const otherStatus = await seedMessage(b, { tenantId: t, status: "generating", updatedAt: OLD, retryCount: 0 });
      const otherTenant = await seedMessage(b, { tenantId: other, status: "sending", updatedAt: OLD, retryCount: 0 });

      const reaped = await b.store.workerReap.retryStuckMessages({
        stuckStatus: "sending",
        retryStatus: "approved",
        threshold: THRESHOLD,
        now: NOW,
        maxRetryCount: 3,
        tenantIds: [t],
      });
      expect(sorted(reaped.map((r) => r.id))).toEqual(sorted([stuck, stuck2]));
      expect(reaped.every((r) => r.tenant_id === t)).toBe(true);
      expect(await getMessage(b, stuck)).toMatchObject({ status: "approved", retryCount: 1, updatedAt: NOW });
      expect(await getMessage(b, stuck2)).toMatchObject({ status: "approved", retryCount: 3 });
      for (const id of [atCap, fresh, otherTenant]) expect((await getMessage(b, id)).status).toBe("sending");
      expect((await getMessage(b, otherStatus)).status).toBe("generating");

      // A second pass finds nothing: the rows are no longer in the stuck status.
      const again = await b.store.workerReap.retryStuckMessages({
        stuckStatus: "sending", retryStatus: "approved", threshold: THRESHOLD, now: NOW, maxRetryCount: 3, tenantIds: [t],
      });
      expect(again).toEqual([]);
    });

    it("retryStuckMessages resets generating to pending_generation", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, { tenantId: t, status: "generating", updatedAt: OLD, retryCount: null });
      const withCount = await seedMessage(b, { tenantId: t, status: "awaiting_content", updatedAt: OLD, retryCount: 1 });
      const reaped = await b.store.workerReap.retryStuckMessages({
        stuckStatus: "generating", retryStatus: "pending_generation", threshold: THRESHOLD, now: NOW, maxRetryCount: 3, tenantIds: [t],
      });
      // retry_count NULL never compares below the cap (same on both engines).
      expect(reaped).toEqual([]);
      expect((await getMessage(b, id)).status).toBe("generating");
      const reaped2 = await b.store.workerReap.retryStuckMessages({
        stuckStatus: "awaiting_content", retryStatus: "pending_generation", threshold: THRESHOLD, now: NOW, maxRetryCount: 3, tenantIds: [t],
      });
      expect(reaped2).toEqual([{ id: withCount, tenant_id: t }]);
      expect(await getMessage(b, withCount)).toMatchObject({ status: "pending_generation", retryCount: 2 });
    });

    it("failStuckMessages fails stuck messages at or above the retry cap", async () => {
      const t = await b.newTenant();
      const atCap = await seedMessage(b, { tenantId: t, status: "awaiting_content", updatedAt: OLD, retryCount: 3 });
      const above = await seedMessage(b, { tenantId: t, status: "awaiting_content", updatedAt: OLD, retryCount: 5 });
      const below = await seedMessage(b, { tenantId: t, status: "awaiting_content", updatedAt: OLD, retryCount: 2 });
      const fresh = await seedMessage(b, { tenantId: t, status: "awaiting_content", updatedAt: NOW, retryCount: 9 });
      const reaped = await b.store.workerReap.failStuckMessages({
        stuckStatus: "awaiting_content", threshold: THRESHOLD, now: NOW, maxRetryCount: 3, tenantIds: [t],
      });
      expect(sorted(reaped.map((r) => r.id))).toEqual(sorted([atCap, above]));
      expect(await getMessage(b, atCap)).toMatchObject({ status: "failed", retryCount: 3, updatedAt: NOW });
      expect((await getMessage(b, below)).status).toBe("awaiting_content");
      expect((await getMessage(b, fresh)).status).toBe("awaiting_content");
    });

    it("without tenantIds (or empty) every tenant is in scope", async () => {
      const t1 = await b.newTenant();
      const t2 = await b.newTenant();
      const m1 = await seedMessage(b, { tenantId: t1, status: "sending", updatedAt: OLD, retryCount: 0 });
      const m2 = await seedMessage(b, { tenantId: t2, status: "sending", updatedAt: OLD, retryCount: 0 });
      const f1 = await seedMessage(b, { tenantId: t1, status: "sending", updatedAt: OLD, retryCount: 7 });
      const retried = await b.store.workerReap.retryStuckMessages({
        stuckStatus: "sending", retryStatus: "approved", threshold: THRESHOLD, now: NOW, maxRetryCount: 3,
      });
      expect(retried.map((r) => r.id)).toEqual(expect.arrayContaining([m1, m2]));
      const failed = await b.store.workerReap.failStuckMessages({
        stuckStatus: "sending", threshold: THRESHOLD, now: NOW, maxRetryCount: 3, tenantIds: [],
      });
      expect(failed.map((r) => r.id)).toContain(f1);
      expect((await getMessage(b, f1)).status).toBe("failed");
    });

    it("concurrent reaps never touch a row twice", async () => {
      const t = await b.newTenant();
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(await seedMessage(b, { tenantId: t, status: "sending", updatedAt: OLD, retryCount: 0 }));
      const input = { stuckStatus: "sending" as const, retryStatus: "approved" as const, threshold: THRESHOLD, now: NOW, maxRetryCount: 3, tenantIds: [t] };
      const results = await Promise.all([b.store.workerReap.retryStuckMessages(input), b.store.workerReap.retryStuckMessages(input)]);
      const all = results.flat().map((r) => r.id);
      expect(sorted(all)).toEqual(sorted(ids));
      for (const id of ids) expect((await getMessage(b, id)).retryCount).toBe(1);
    });
  });
}
