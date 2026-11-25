/**
 * G3 date-property triggers and schedules, on Postgres (when DATABASE_URL is
 * set) and D1: enrollment once per anchor, re-enrollment when the date moves,
 * a schedule that sends exactly max_sends and stops on an exit condition,
 * date_unchanged, and step expires_after.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { storeFor } from "@claros/store";
import { phaseDateEnrollment } from "../src/date-flows.js";
import { phaseStepAdvancement } from "../src/scan-step-advancement.js";
import { handleAdvanceMembership } from "../src/advance-membership.js";
import { engineBackends, type EngineBackend } from "./support/engine-backends.js";

const MIN = 60_000;
const DAY = 86_400_000;

for (const factory of engineBackends()) {
  describe(`date triggers (${factory.name})`, () => {
    let b: EngineBackend;
    beforeAll(async () => {
      b = await factory.open();
    });
    afterAll(async () => {
      await b.close();
    });

    async function setup(trigger: Record<string, unknown>, opts: { steps?: unknown[]; exits?: unknown[]; flowClass?: string } = {}) {
      const tenantId = await b.newTenant({ date_traits: ["trial_ends_at", "first_paid_at"] });
      const flowId = randomUUID();
      const { type, ...condition } = trigger;
      const steps = opts.steps ?? [{ order: 1, action_type: "reminder", delay: "0m", template_ref: "t" }];
      await b.db.insert(b.schema.flows).values({
        id: flowId,
        tenantId,
        name: "dated",
        triggerType: type,
        triggerConfig: condition,
        steps,
        status: "active",
        compileStatus: "ready",
        compiledPlan: { trigger: { type, condition }, steps, ...(opts.exits ? { exit_conditions: opts.exits } : {}) },
        flowClass: opts.flowClass ?? "critical",
        approvalMode: "auto",
      });
      return { tenantId, flowId };
    }

    async function addContact(tenantId: string, props: Record<string, unknown>) {
      const externalId = `u-${randomUUID().slice(0, 8)}`;
      const id = randomUUID();
      await b.db.insert(b.schema.contacts).values({ id, tenantId, externalId, email: `${externalId}@example.com`, lifecycleState: "activated", properties: props });
      await storeFor(b.db).apiIngest.syncContactDates({ tenantId, externalId, changedKeys: Object.keys(props), now: new Date() });
      return { id, externalId };
    }

    async function setProps(tenantId: string, contact: { id: string; externalId: string }, props: Record<string, unknown>) {
      await b.db.update(b.schema.contacts).set({ properties: props }).where(eq(b.schema.contacts.id, contact.id));
      await storeFor(b.db).apiIngest.syncContactDates({ tenantId, externalId: contact.externalId, changedKeys: Object.keys(props), now: new Date() });
    }

    async function scan(tenantId: string, now: Date) {
      const e = await phaseDateEnrollment(b.db, now, [tenantId]);
      const s = await phaseStepAdvancement(b.db, now, [tenantId]);
      return { e, s };
    }

    const memberships = (tenantId: string, flowId: string) =>
      b.db.select().from(b.schema.flowMemberships).where(and(eq(b.schema.flowMemberships.tenantId, tenantId), eq(b.schema.flowMemberships.flowId, flowId)));
    const messages = (tenantId: string, flowId: string) =>
      b.db.select().from(b.schema.lifecycleMessages).where(and(eq(b.schema.lifecycleMessages.tenantId, tenantId), eq(b.schema.lifecycleMessages.flowId, flowId)));

    it("date_property: trial_ends_at = now + 3d + 5m enrolls exactly once at -3d", async () => {
      const { tenantId, flowId } = await setup({ type: "date_property", property: "trial_ends_at", offset: "-3d" });
      const t0 = new Date("2026-12-01T10:00:00Z");
      const trialEnds = new Date(t0.getTime() + 3 * DAY + 5 * MIN);
      const contact = await addContact(tenantId, { trial_ends_at: trialEnds.toISOString() });

      await scan(tenantId, t0);
      expect(await memberships(tenantId, flowId)).toHaveLength(0);

      await scan(tenantId, new Date(t0.getTime() + 15 * MIN));
      await scan(tenantId, new Date(t0.getTime() + 30 * MIN));
      await scan(tenantId, new Date(t0.getTime() + 2 * DAY));
      const ms = await memberships(tenantId, flowId);
      expect(ms).toHaveLength(1);
      expect(new Date(ms[0].anchorAt).getTime()).toBe(trialEnds.getTime());
      const msgs = await messages(tenantId, flowId);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].contactId).toBe(contact.id);
    });

    it("date_property: moving the date re-enrolls for the new anchor", async () => {
      const { tenantId, flowId } = await setup({ type: "date_property", property: "trial_ends_at", offset: "-3d" });
      const t0 = new Date("2026-12-01T10:00:00Z");
      const first = new Date(t0.getTime() + 3 * DAY + 5 * MIN);
      const contact = await addContact(tenantId, { trial_ends_at: first.toISOString() });
      await scan(tenantId, new Date(t0.getTime() + 15 * MIN));
      expect(await memberships(tenantId, flowId)).toHaveLength(1);

      // Trial extended by a week: one more enrollment when the new date is due.
      const moved = new Date(first.getTime() + 7 * DAY);
      await setProps(tenantId, contact, { trial_ends_at: moved.toISOString() });
      await scan(tenantId, new Date(t0.getTime() + 1 * DAY));
      expect(await memberships(tenantId, flowId)).toHaveLength(1);
      await scan(tenantId, new Date(moved.getTime() - 3 * DAY + 10 * MIN));
      await scan(tenantId, new Date(moved.getTime() - 3 * DAY + 40 * MIN));
      const ms = await memberships(tenantId, flowId);
      expect(ms).toHaveLength(2);
      expect(ms.map((m: any) => new Date(m.anchorAt).getTime()).sort()).toEqual([first.getTime(), moved.getTime()]);
      expect(await messages(tenantId, flowId)).toHaveLength(2);
    });

    it("date_property: moving the date while a step is pending skips the stale step", async () => {
      const steps = [
        { order: 1, action_type: "heads_up", delay: "0m", template_ref: "t" },
        { order: 2, action_type: "last_call", delay: "2d", template_ref: "t" },
      ];
      const { tenantId, flowId } = await setup({ type: "date_property", property: "trial_ends_at", offset: "-3d" }, { steps });
      const t0 = new Date("2026-12-01T10:00:00Z");
      const first = new Date(t0.getTime() + 3 * DAY);
      const contact = await addContact(tenantId, { trial_ends_at: first.toISOString() });
      await scan(tenantId, new Date(t0.getTime() + 1 * MIN));
      expect(await messages(tenantId, flowId)).toHaveLength(1);

      await setProps(tenantId, contact, { trial_ends_at: new Date(first.getTime() + 30 * DAY).toISOString() });
      await scan(tenantId, new Date(t0.getTime() + 2 * DAY + 1 * MIN));
      const ms = await memberships(tenantId, flowId);
      expect(ms).toHaveLength(1);
      expect(ms[0].status).toBe("exited");
      expect(ms[0].exitReason).toBe("date_changed");
      // Step 2 of the stale enrollment never ran.
      expect((await messages(tenantId, flowId)).map((m: any) => m.brainActionType)).toEqual(["heads_up"]);
    });

    it("date_schedule: offsets 1d..30d, repeat 30d, max_sends 7 sends exactly 7", async () => {
      const trigger = { type: "date_schedule", anchor: "first_paid_at", offsets: ["1d", "3d", "7d", "14d", "30d"], repeat: "30d", max_sends: 7 };
      const { tenantId, flowId } = await setup(trigger, { flowClass: "nurture" });
      const paid = new Date("2026-12-01T08:00:00Z");
      await addContact(tenantId, { first_paid_at: paid.toISOString() });
      const offsetsDays = [1, 3, 7, 14, 30, 60, 90, 120, 150];
      await scan(tenantId, new Date(paid.getTime() + 1 * MIN));
      for (const d of offsetsDays) {
        await scan(tenantId, new Date(paid.getTime() + d * DAY + 5 * MIN));
        await scan(tenantId, new Date(paid.getTime() + d * DAY + 20 * MIN));
      }
      const msgs = await messages(tenantId, flowId);
      expect(msgs).toHaveLength(7);
      expect(msgs.map((m: any) => m.flowStepOrder).sort((a: number, z: number) => a - z)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const ms = await memberships(tenantId, flowId);
      expect(ms).toHaveLength(1);
      expect(ms[0].status).toBe("completed");
    });

    it("date_schedule: stops when an exit trait condition becomes true", async () => {
      const trigger = { type: "date_schedule", anchor: "first_paid_at", offsets: ["1d", "3d", "7d", "14d", "30d"], repeat: "30d", max_sends: 7 };
      const { tenantId, flowId } = await setup(trigger, {
        flowClass: "nurture",
        exits: [{ trait: { key: "icp_configured", op: "eq", value: true } }],
      });
      const paid = new Date("2026-12-01T08:00:00Z");
      const contact = await addContact(tenantId, { first_paid_at: paid.toISOString(), icp_configured: false });
      for (const d of [1, 3, 7]) await scan(tenantId, new Date(paid.getTime() + d * DAY + 5 * MIN));
      expect(await messages(tenantId, flowId)).toHaveLength(3);

      await setProps(tenantId, contact, { first_paid_at: paid.toISOString(), icp_configured: true });
      for (const d of [14, 30, 60, 90]) await scan(tenantId, new Date(paid.getTime() + d * DAY + 5 * MIN));
      expect(await messages(tenantId, flowId)).toHaveLength(3);
      const ms = await memberships(tenantId, flowId);
      expect(ms).toHaveLength(1);
      expect(ms[0].status).toBe("exited");
      expect(ms[0].exitReason).toBe("condition_met");
    });

    it("date_schedule: where conditions are re-checked at each send", async () => {
      const trigger = {
        type: "date_schedule",
        anchor: "first_paid_at",
        offsets: ["1d", "3d", "7d"],
        max_sends: 3,
        where: [{ trait: { key: "payment_status_x", op: "eq", value: "paid" } }],
      };
      const { tenantId, flowId } = await setup(trigger);
      const paid = new Date("2026-12-01T08:00:00Z");
      const contact = await addContact(tenantId, { first_paid_at: paid.toISOString(), payment_status_x: "paid" });
      await scan(tenantId, new Date(paid.getTime() + 1 * DAY + 5 * MIN));
      await setProps(tenantId, contact, { first_paid_at: paid.toISOString(), payment_status_x: "past_due" });
      await scan(tenantId, new Date(paid.getTime() + 3 * DAY + 5 * MIN));
      await setProps(tenantId, contact, { first_paid_at: paid.toISOString(), payment_status_x: "paid" });
      await scan(tenantId, new Date(paid.getTime() + 7 * DAY + 5 * MIN));
      expect((await messages(tenantId, flowId)).map((m: any) => m.flowStepOrder).sort()).toEqual([1, 3]);
    });

    it("date_schedule: a backfilled old anchor never sends stale slots", async () => {
      const trigger = { type: "date_schedule", anchor: "first_paid_at", offsets: ["1d", "3d", "7d"], max_sends: 3 };
      const { tenantId, flowId } = await setup(trigger);
      const now = new Date("2026-12-20T08:00:00Z");
      await addContact(tenantId, { first_paid_at: new Date(now.getTime() - 60 * DAY).toISOString() });
      await scan(tenantId, now);
      expect(await memberships(tenantId, flowId)).toHaveLength(0);
      expect(await messages(tenantId, flowId)).toHaveLength(0);
    });

    it("send_at_local schedules the slot at the contact's local time", async () => {
      const { tenantId, flowId } = await setup({ type: "date_property", property: "trial_ends_at", offset: "-1d", send_at_local: "09:00" });
      // Trial ends 2026-12-10T20:00Z; -1d is 2026-12-09, 09:00 in New York = 14:00Z.
      await addContact(tenantId, { trial_ends_at: "2026-12-10T20:00:00Z", timezone: "America/New_York" });
      await scan(tenantId, new Date("2026-12-09T13:50:00Z"));
      expect(await memberships(tenantId, flowId)).toHaveLength(0);
      await scan(tenantId, new Date("2026-12-09T14:05:00Z"));
      expect(await memberships(tenantId, flowId)).toHaveLength(1);
    });

    it("date_unchanged step condition and the targeted advance job", async () => {
      const steps = [{ order: 1, action_type: "reminder", delay: "0m", template_ref: "t", condition: { date_unchanged: true } }];
      const { tenantId, flowId } = await setup({ type: "date_property", property: "trial_ends_at", offset: "-3d" }, { steps });
      const t0 = new Date();
      await addContact(tenantId, { trial_ends_at: new Date(t0.getTime() + 3 * DAY - 5 * MIN).toISOString() });
      await phaseDateEnrollment(b.db, t0, [tenantId]);
      const [m] = await memberships(tenantId, flowId);
      const r = await handleAdvanceMembership({ tenant_id: tenantId, membership_id: m.id }, b.db);
      expect(r.messageCreated).toBe(true);
    });

    it("expires_after cancels an unsent message with reason expired", async () => {
      const steps = [{ order: 1, action_type: "reminder", delay: "0m", template_ref: "t", expires_after: "2h" }];
      const { tenantId, flowId } = await setup({ type: "date_property", property: "trial_ends_at", offset: "0m" }, { steps });
      const t0 = new Date("2026-12-01T10:00:00Z");
      await addContact(tenantId, { trial_ends_at: t0.toISOString() });
      await scan(tenantId, new Date(t0.getTime() + 1 * MIN));
      let [msg] = await messages(tenantId, flowId);
      expect(msg.status).toBe("pending_generation");
      expect(msg.expiresAt).not.toBeNull();
      const r = await phaseDateEnrollment(b.db, new Date(t0.getTime() + 3 * 60 * MIN), [tenantId]);
      expect(r.expiredCancelled).toBeGreaterThanOrEqual(1);
      [msg] = await messages(tenantId, flowId);
      expect(msg.status).toBe("cancelled");
      expect(msg.statusReason).toBe("expired");
    });
  });
}
