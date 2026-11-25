/**
 * Contract tests for the ops store area (every backend).
 *
 * ops_events and ops_alerts are instance-level; the shared Postgres holds
 * other runs' rows, so every assertion is on this test's fingerprints,
 * tenants and keys. Time-based methods use dates no other test writes
 * (1940s for retention and staleness, 2090s for windows).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import { addTransport, addUser, uniqueEmail } from "./support/identity.js";
import { insertContact, insertFlow, insertMembership, insertMessage } from "./support/worker-fixtures.js";

const fp = (tag: string) => `test|${tag}|${randomUUID()}`;
const at = (iso: string) => new Date(iso);

for (const factory of testBackends()) {
  describe(`ops on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      // Leave no open test alerts behind in a shared database (a dev server would mail them).
      await b.db.delete(b.schema.opsAlerts).where(like(b.schema.opsAlerts.fingerprint, "test|%"));
      await b.db.delete(b.schema.opsEvents).where(like(b.schema.opsEvents.fingerprint, "test|%"));
      await b.close();
    });

    const event = (fingerprint: string, iso: string, extra: Record<string, unknown> = {}) => ({
      at: at(iso),
      tenantId: null,
      kind: "job_failed",
      severity: "error",
      fingerprint,
      message: `boom ${iso}`,
      context: { job: "claros.scan", n: null },
      ...extra,
    });

    it("recordEvent with alert opens the alert, bumps it, and a resolved alert reopens as new", async () => {
      const f = fp("record");
      const tenantId = await b.newTenant();
      await b.store.ops.recordEvent(event(f, "2090-01-01T00:00:00Z", { tenantId }), { alert: true });
      expect(await b.store.ops.getAlert(f)).toEqual({
        fingerprint: f,
        kind: "job_failed",
        tenantId,
        severity: "error",
        message: "boom 2090-01-01T00:00:00Z",
        firstAt: at("2090-01-01T00:00:00Z"),
        lastAt: at("2090-01-01T00:00:00Z"),
        count: 1,
        lastNotifiedAt: null,
        notifiedCount: 0,
        status: "open",
        mutedUntil: null,
      });

      await b.store.ops.recordEvent(event(f, "2090-01-01T00:05:00Z", { tenantId, severity: "critical" }), { alert: true });
      expect(await b.store.ops.claimNotification({ fingerprint: f, expectedLastNotifiedAt: null, at: at("2090-01-01T00:06:00Z") })).toBe(true);
      // An older occurrence arriving late does not move last_at back.
      await b.store.ops.recordEvent(event(f, "2090-01-01T00:01:00Z", { tenantId }), { alert: true });
      const bumped = await b.store.ops.getAlert(f);
      expect(bumped).toMatchObject({
        firstAt: at("2090-01-01T00:00:00Z"),
        lastAt: at("2090-01-01T00:05:00Z"),
        count: 3,
        severity: "error",
        message: "boom 2090-01-01T00:01:00Z",
        lastNotifiedAt: at("2090-01-01T00:06:00Z"),
        notifiedCount: 2,
        status: "open",
      });

      expect((await b.store.ops.resolveAlert({ fingerprint: f }))?.status).toBe("resolved");
      expect(await b.store.ops.resolveAlert({ fingerprint: f })).toBeNull();
      await b.store.ops.recordEvent(event(f, "2090-01-02T00:00:00Z", { tenantId }), { alert: true });
      expect(await b.store.ops.getAlert(f)).toMatchObject({
        firstAt: at("2090-01-02T00:00:00Z"),
        lastAt: at("2090-01-02T00:00:00Z"),
        count: 1,
        lastNotifiedAt: null,
        notifiedCount: 0,
        status: "open",
      });

      const events = (await b.store.ops.listEvents({ since: at("2090-01-01T00:00:00Z"), limit: 1000 })).filter(
        (e) => e.fingerprint === f,
      );
      expect(events.map((e) => e.at)).toEqual([
        at("2090-01-02T00:00:00Z"),
        at("2090-01-01T00:05:00Z"),
        at("2090-01-01T00:01:00Z"),
        at("2090-01-01T00:00:00Z"),
      ]);
      expect(events[0]).toMatchObject({ tenantId, kind: "job_failed", context: { job: "claros.scan", n: null } });
    });

    it("recordEvent without alert writes the event only", async () => {
      const f = fp("noalert");
      await b.store.ops.recordEvent(event(f, "2090-02-01T00:00:00Z", { context: null }), { alert: false });
      expect(await b.store.ops.getAlert(f)).toBeNull();
      const events = (await b.store.ops.listEvents({ since: at("2090-02-01T00:00:00Z"), limit: 1000 })).filter(
        (e) => e.fingerprint === f,
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.context).toBeNull();
    });

    it("concurrent recordEvent calls count every occurrence once", async () => {
      const f = fp("concurrent");
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          b.store.ops.recordEvent(event(f, `2090-03-01T00:00:0${i}Z`), { alert: true }),
        ),
      );
      expect((await b.store.ops.getAlert(f))?.count).toBe(8);
    });

    it("touchAlert bumps an open alert only", async () => {
      const f = fp("touch");
      expect(await b.store.ops.touchAlert({ fingerprint: f, at: at("2090-04-01T00:00:00Z") })).toBe(false);
      await b.store.ops.recordEvent(event(f, "2090-04-01T00:00:00Z"), { alert: true });
      expect(await b.store.ops.touchAlert({ fingerprint: f, at: at("2090-04-01T00:10:00Z") })).toBe(true);
      expect(await b.store.ops.getAlert(f)).toMatchObject({ count: 2, lastAt: at("2090-04-01T00:10:00Z") });
      await b.store.ops.resolveAlert({ fingerprint: f });
      expect(await b.store.ops.touchAlert({ fingerprint: f, at: at("2090-04-01T00:20:00Z") })).toBe(false);
    });

    it("claimNotification is a compare-and-swap: one of two concurrent claims wins", async () => {
      const f = fp("claim");
      await b.store.ops.recordEvent(event(f, "2090-05-01T00:00:00Z"), { alert: true });
      const results = await Promise.all([
        b.store.ops.claimNotification({ fingerprint: f, expectedLastNotifiedAt: null, at: at("2090-05-01T00:01:00Z") }),
        b.store.ops.claimNotification({ fingerprint: f, expectedLastNotifiedAt: null, at: at("2090-05-01T00:01:00Z") }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      // A repeat claim must name the last notification.
      expect(await b.store.ops.claimNotification({ fingerprint: f, expectedLastNotifiedAt: null, at: at("2090-05-01T01:02:00Z") })).toBe(false);
      expect(
        await b.store.ops.claimNotification({
          fingerprint: f,
          expectedLastNotifiedAt: at("2090-05-01T00:01:00Z"),
          at: at("2090-05-01T01:02:00Z"),
        }),
      ).toBe(true);
      expect(await b.store.ops.getAlert(f)).toMatchObject({ lastNotifiedAt: at("2090-05-01T01:02:00Z"), notifiedCount: 1 });
    });

    it("listAlerts filters by status and orders by last occurrence, newest first", async () => {
      const f1 = fp("list1");
      const f2 = fp("list2");
      await b.store.ops.recordEvent(event(f1, "2099-06-01T00:00:00Z"), { alert: true });
      await b.store.ops.recordEvent(event(f2, "2099-06-02T00:00:00Z"), { alert: true });
      await b.store.ops.resolveAlert({ fingerprint: f1 });
      const all = (await b.store.ops.listAlerts({ limit: 10_000 })).filter((a) => a.fingerprint === f1 || a.fingerprint === f2);
      expect(all.map((a) => a.fingerprint)).toEqual([f2, f1]);
      const open = (await b.store.ops.listAlerts({ status: "open", limit: 10_000 })).map((a) => a.fingerprint);
      expect(open).toContain(f2);
      expect(open).not.toContain(f1);
      const resolved = (await b.store.ops.listAlerts({ status: "resolved", limit: 10_000 })).map((a) => a.fingerprint);
      expect(resolved).toContain(f1);
      expect(resolved).not.toContain(f2);
    });

    it("resolveStaleAlerts resolves open alerts last seen before the cutoff and returns them", async () => {
      const stale = fp("stale");
      const fresh = fp("fresh");
      await b.store.ops.recordEvent(event(stale, "1941-01-01T00:00:00Z"), { alert: true });
      await b.store.ops.recordEvent(event(fresh, "1941-01-01T02:00:00Z"), { alert: true });
      const resolved = await b.store.ops.resolveStaleAlerts({ before: at("1941-01-01T01:00:00Z") });
      expect(resolved.map((a) => a.fingerprint)).toContain(stale);
      expect(resolved.map((a) => a.fingerprint)).not.toContain(fresh);
      expect(resolved.find((a) => a.fingerprint === stale)?.status).toBe("resolved");
      expect((await b.store.ops.getAlert(fresh))?.status).toBe("open");
      await b.store.ops.resolveAlert({ fingerprint: fresh });
    });

    it("muteAlert sets muted_until; an unknown fingerprint gives null", async () => {
      const f = fp("mute");
      expect(await b.store.ops.muteAlert({ fingerprint: f, until: at("2090-07-01T00:00:00Z") })).toBeNull();
      await b.store.ops.recordEvent(event(f, "2090-07-01T00:00:00Z"), { alert: true });
      expect((await b.store.ops.muteAlert({ fingerprint: f, until: at("2090-07-02T00:00:00Z") }))?.mutedUntil).toEqual(
        at("2090-07-02T00:00:00Z"),
      );
    });

    it("groupEventsSince groups by fingerprint with the latest message; countEventsSince counts kinds", async () => {
      const f1 = fp("group1");
      const f2 = fp("group2");
      const tenantId = await b.newTenant();
      for (let i = 0; i < 3; i++) {
        await b.store.ops.recordEvent(event(f1, `2090-08-01T00:0${i}:00Z`, { kind: "dead_letter", tenantId }), { alert: false });
      }
      await b.store.ops.recordEvent(event(f2, "2090-08-01T00:09:00Z", { kind: "tick_late", severity: "critical" }), { alert: false });
      await b.store.ops.recordEvent(event(f2, "2090-07-31T00:00:00Z", { kind: "tick_late" }), { alert: false });
      const groups = (await b.store.ops.groupEventsSince({ since: at("2090-08-01T00:00:00Z") })).filter(
        (g) => g.fingerprint === f1 || g.fingerprint === f2,
      );
      expect(groups).toEqual([
        {
          fingerprint: f1,
          kind: "dead_letter",
          tenantId,
          severity: "error",
          message: "boom 2090-08-01T00:02:00Z",
          count: 3,
          lastAt: at("2090-08-01T00:02:00Z"),
        },
        {
          fingerprint: f2,
          kind: "tick_late",
          tenantId: null,
          severity: "critical",
          message: "boom 2090-08-01T00:09:00Z",
          count: 1,
          lastAt: at("2090-08-01T00:09:00Z"),
        },
      ]);
      const kind = `k-${randomUUID().slice(0, 8)}`;
      await b.store.ops.recordEvent(event(fp("count"), "2090-08-02T00:00:00Z", { kind }), { alert: false });
      await b.store.ops.recordEvent(event(fp("count"), "2090-08-02T00:00:00Z", { kind }), { alert: false });
      await b.store.ops.recordEvent(event(fp("count"), "2090-07-02T00:00:00Z", { kind }), { alert: false });
      expect(await b.store.ops.countEventsSince({ kinds: [kind, "nope-kind"], since: at("2090-08-01T00:00:00Z") })).toBe(2);
      expect(await b.store.ops.countEventsSince({ kinds: [], since: at("2090-08-01T00:00:00Z") })).toBe(0);
    });

    it("deleteEventsBefore and deleteResolvedAlertsBefore remove old rows only", async () => {
      const old = fp("old");
      const keep = fp("keep");
      await b.store.ops.recordEvent(event(old, "1940-01-01T00:00:00Z"), { alert: true });
      await b.store.ops.recordEvent(event(keep, "1940-03-01T00:00:00Z"), { alert: true });
      await b.store.ops.resolveAlert({ fingerprint: old });
      expect(await b.store.ops.deleteEventsBefore(at("1940-02-01T00:00:00Z"))).toBeGreaterThanOrEqual(1);
      expect(await b.store.ops.deleteResolvedAlertsBefore(at("1940-02-01T00:00:00Z"))).toBeGreaterThanOrEqual(1);
      expect(await b.store.ops.getAlert(old)).toBeNull();
      expect(await b.store.ops.getAlert(keep)).not.toBeNull();
      const left = (await b.store.ops.listEvents({ since: at("1939-01-01T00:00:00Z"), limit: 100_000 })).map((e) => e.fingerprint);
      expect(left).not.toContain(old);
      expect(left).toContain(keep);
      await b.store.ops.resolveAlert({ fingerprint: keep });
    });

    it("settings: get, put, list and delete by prefix", async () => {
      const run = randomUUID().slice(0, 8);
      const prefix = `zz${run}.`;
      expect(await b.store.ops.getSetting(`${prefix}a`)).toBeNull();
      await b.store.ops.putSetting({ key: `${prefix}b`, value: { last_run_at: "x" }, now: at("2026-01-01T00:00:00Z") });
      await b.store.ops.putSetting({ key: `${prefix}a`, value: "first", now: at("2026-01-03T00:00:00Z") });
      await b.store.ops.putSetting({ key: `${prefix}a`, value: "second", now: at("2026-01-04T00:00:00Z") });
      await b.store.ops.putSetting({ key: `zz${run}_c`, value: 1, now: at("2026-01-01T00:00:00Z") });
      expect(await b.store.ops.getSetting(`${prefix}a`)).toEqual({ key: `${prefix}a`, value: "second", updatedAt: at("2026-01-04T00:00:00Z") });
      // "_" in the prefix is literal, not a wildcard.
      expect((await b.store.ops.listSettingsByPrefix(prefix)).map((s) => s.key)).toEqual([`${prefix}a`, `${prefix}b`]);
      expect(await b.store.ops.deleteSettingsByPrefixBefore({ prefix, before: at("2026-01-02T00:00:00Z") })).toBe(1);
      expect((await b.store.ops.listSettingsByPrefix(prefix)).map((s) => s.key)).toEqual([`${prefix}a`]);
      await b.db.delete(b.schema.instanceSettings).where(like(b.schema.instanceSettings.key, `zz${run}%`));
    });

    it("bumpCounter adds within a window, starts over in a new one, and is atomic under concurrency", async () => {
      const key = `zzcounter.${randomUUID()}`;
      const now = at("2026-01-01T00:00:00Z");
      expect(await b.store.ops.bumpCounter({ key, windowStart: 1000, count: 2, errors: 1, now })).toEqual({ count: 2, errors: 1 });
      expect(await b.store.ops.bumpCounter({ key, windowStart: 1000, count: 3, errors: 0, now })).toEqual({ count: 5, errors: 1 });
      await Promise.all(
        Array.from({ length: 10 }, () => b.store.ops.bumpCounter({ key, windowStart: 1000, count: 1, errors: 1, now })),
      );
      expect(await b.store.ops.bumpCounter({ key, windowStart: 1000, count: 0, errors: 0, now })).toEqual({ count: 15, errors: 11 });
      expect(await b.store.ops.bumpCounter({ key, windowStart: 2000, count: 1, errors: 0, now })).toEqual({ count: 1, errors: 0 });
      expect((await b.store.ops.getSetting(key))?.value).toEqual({ window_start: 2000, count: 1, errors: 0 });
      await b.db.delete(b.schema.instanceSettings).where(like(b.schema.instanceSettings.key, key));
    });

    describe("message queries", () => {
      it("sendOutcomesSince counts sends, failures and stuck attempts per product and transport", async () => {
        const tenantId = await b.newTenant();
        const transportId = await addTransport(b, tenantId, { kind: "resend", name: "Main" });
        const contactId = await insertContact(b, tenantId);
        const flowId = await insertFlow(b, tenantId);
        const membershipId = await insertMembership(b, { tenantId, contactId, flowId });
        let step = 0;
        const msg = async (values: Record<string, unknown>) =>
          insertMessage(b, {
            tenantId,
            contactId,
            flowId,
            membershipId,
            flowStepOrder: ++step,
            recipientAddress: "a@example.com",
            ...values,
          });
        const since = at("2091-01-01T00:00:00Z");
        const stuckBefore = at("2091-01-01T00:13:00Z");
        await msg({ status: "sent", sentAt: at("2091-01-01T00:01:00Z"), transportId });
        await msg({ status: "sent", sentAt: at("2091-01-01T00:02:00Z"), transportId });
        await msg({ status: "sent", sentAt: at("2090-12-31T23:00:00Z"), transportId }); // before the window
        await msg({ status: "failed", updatedAt: at("2091-01-01T00:03:00Z"), transportId, statusReason: "provider_error: x" });
        await msg({ status: "sending", updatedAt: at("2091-01-01T00:04:00Z"), transportId }); // stuck
        await msg({ status: "sending", updatedAt: at("2091-01-01T00:14:00Z"), transportId }); // in flight
        await msg({ status: "failed", updatedAt: at("2091-01-01T00:05:00Z"), recipientAddress: null, transportId }); // never attempted
        await msg({ status: "failed", updatedAt: at("2091-01-01T00:06:00Z") }); // no transport recorded
        const rows = (await b.store.ops.sendOutcomesSince({ since, stuckBefore })).filter((r) => r.tenantId === tenantId);
        expect(rows).toEqual([
          { tenantId, transportId, transportKind: "resend", transportName: "Main", sent: 2, failed: 1, stuck: 1 },
          { tenantId, transportId: null, transportKind: null, transportName: null, sent: 0, failed: 1, stuck: 0 },
        ]);

        const reasons = (await b.store.ops.sendFailureReasonsSince({ since, limit: 1000 })).filter((r) => r.tenantId === tenantId);
        expect(reasons).toEqual([{ tenantId, transportId, transportKind: "resend", reason: "provider_error: x" }]);

        const totals = (await b.store.ops.sendTotalsSince(since)).filter((r) => r.tenantId === tenantId);
        expect(totals).toEqual([{ tenantId, sent: 2, failed: 3 }]);
      });

      it("pendingApprovals counts per product with the oldest creation time", async () => {
        const tenantId = await b.newTenant();
        const contactId = await insertContact(b, tenantId);
        const flowId = await insertFlow(b, tenantId);
        const membershipId = await insertMembership(b, { tenantId, contactId, flowId });
        let step = 0;
        for (const [status, createdAt] of [
          ["pending_approval", "2026-01-02T00:00:00Z"],
          ["pending_approval", "2026-01-01T00:00:00Z"],
          ["approved", "2025-01-01T00:00:00Z"],
        ] as const) {
          await insertMessage(b, { tenantId, contactId, flowId, membershipId, flowStepOrder: ++step, status, createdAt: at(createdAt) });
        }
        const rows = (await b.store.ops.pendingApprovals()).filter((r) => r.tenantId === tenantId);
        expect(rows).toEqual([{ tenantId, pending: 2, oldestAt: at("2026-01-01T00:00:00Z") }]);
      });
    });

    it("listProducts lists products oldest first", async () => {
      const a = randomUUID();
      const c = randomUUID();
      await b.db.insert(b.schema.tenants).values({ id: c, name: "C", slug: `c-${c.slice(0, 8)}`, createdAt: at("2026-01-02T00:00:00Z") });
      await b.db.insert(b.schema.tenants).values({ id: a, name: "A", slug: `a-${a.slice(0, 8)}`, createdAt: at("2026-01-01T00:00:00Z") });
      const mine = (await b.store.ops.listProducts()).filter((p) => p.id === a || p.id === c);
      expect(mine).toEqual([
        { id: a, slug: `a-${a.slice(0, 8)}`, name: "A" },
        { id: c, slug: `c-${c.slice(0, 8)}`, name: "C" },
      ]);
    });

    it("firstInstanceAdminEmail is the oldest active instance admin", async () => {
      const tenantId = await b.newTenant();
      // Earlier on every run, so this run's admin is the oldest in a shared database.
      const oldest = new Date(-Date.now());
      const email = uniqueEmail("admin");
      await addUser(b, tenantId, { email, instanceRole: "admin", createdAt: oldest });
      await addUser(b, tenantId, { instanceRole: "admin", createdAt: new Date(oldest.getTime() - 1000), deactivatedAt: new Date() });
      await addUser(b, tenantId, { instanceRole: null, createdAt: new Date(oldest.getTime() - 2000) });
      expect(await b.store.ops.firstInstanceAdminEmail()).toBe(email);
    });
  });
}
