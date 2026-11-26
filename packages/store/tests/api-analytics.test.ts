/**
 * Contract tests for the apiAnalytics store area, on every backend.
 *
 * Fixtures spread transitions, messages and message events over several UTC
 * days (some outside the window); expectations are computed in JS from the
 * same fixture data, so pg and d1 are held to identical results.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";

const H = 3_600_000;
const D = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const POSITIVE = ["activated", "engaged", "resurrected"];
const NEGATIVE = ["at_risk", "dormant", "churned"];

type Tx = { from: string; to: string; ago: number };
type Msg = {
  flow: "A" | "B";
  status: string;
  feedback: string | null;
  sentAgo: number | null;
  createdAgo: number;
};
type MEv = { msg: number; type: string; ago: number };

const TRANSITIONS: Tx[] = [
  { from: "signed_up", to: "activated", ago: 2 * D + 1 * H },
  { from: "activated", to: "engaged", ago: 2 * D + 2 * H },
  { from: "engaged", to: "at_risk", ago: 5 * D + 3 * H },
  { from: "engaged", to: "at_risk", ago: 5 * D + 4 * H },
  { from: "engaged", to: "at_risk", ago: 12 * D },
  { from: "at_risk", to: "churned", ago: 10 * D },
  { from: "churned", to: "resurrected", ago: 12 * D + 5 * H },
  { from: "at_risk", to: "resurrected", ago: 45 * D }, // outside a 30-day window
];

const MESSAGES: Msg[] = [
  { flow: "A", status: "sent", feedback: "opened", sentAgo: 1 * D, createdAgo: 1 * D + 1 * H },
  { flow: "A", status: "sent", feedback: "clicked", sentAgo: 1 * D + 2 * H, createdAgo: 1 * D + 3 * H },
  { flow: "A", status: "sent", feedback: "bounced", sentAgo: 3 * D, createdAgo: 3 * D + 1 * H },
  { flow: "B", status: "sent", feedback: "complained", sentAgo: 3 * D + 2 * H, createdAgo: 3 * D + 3 * H },
  { flow: "B", status: "suppressed", feedback: null, sentAgo: null, createdAgo: 4 * D },
  { flow: "B", status: "failed", feedback: null, sentAgo: null, createdAgo: 6 * D },
  { flow: "A", status: "sent", feedback: null, sentAgo: 40 * D, createdAgo: 40 * D },
  // created outside the window, sent inside it
  { flow: "A", status: "sent", feedback: "opened", sentAgo: 20 * D, createdAgo: 35 * D },
];

const MESSAGE_EVENTS: MEv[] = [
  { msg: 0, type: "opened", ago: 1 * D - 2 * H },
  { msg: 1, type: "opened", ago: 1 * D },
  { msg: 1, type: "clicked", ago: 1 * D - 1 * H },
  { msg: 2, type: "bounced", ago: 3 * D - 1 * H },
  { msg: 2, type: "delivered", ago: 3 * D - 2 * H }, // not counted
  { msg: 0, type: "opened", ago: 7 * D },
  { msg: 7, type: "opened", ago: 50 * D }, // outside the window, earliest event
];

const TENURE = { growing: 30, established: 90, loyal: 365 };
const RECENCY = { cooling: 7, idle: 30, dormant: 90 };

interface Seeded {
  tenantId: string;
  now: number;
  contactIds: string[];
  flowIds: { A: string; B: string };
}

async function seed(b: Backend): Promise<Seeded> {
  const s = b.schema as any;
  const now = Date.now();
  const at = (ago: number) => new Date(now - ago);
  const tenantId = await b.newTenant("Analytics");
  await b.db
    .update(s.tenants)
    .set({ settings: { lifecycle: { natural_frequency_days: 7 } } })
    .where(eq(s.tenants.id, tenantId));

  const contactDefs = [
    { state: "engaged", depth: "power", pay: "paid", first: 5 * D, last: 1 * H },
    { state: "engaged", depth: "regular", pay: "free", first: 40 * D, last: 10 * D },
    { state: "at_risk", depth: null, pay: "past_due", first: 200 * D, last: 50 * D },
    { state: "at_risk", depth: "casual", pay: "trial", first: 400 * D, last: 100 * D },
    { state: "churned", depth: "minimal", pay: "cancelled", first: null, last: null },
  ];
  const contactIds = contactDefs.map(() => randomUUID());
  await b.db.insert(s.contacts).values(
    contactDefs.map((c, i) => ({
      id: contactIds[i],
      tenantId,
      externalId: `u${i}`,
      email: `u${i}@example.com`,
      name: `User ${i}`,
      lifecycleState: c.state,
      engagementDepth: c.depth,
      paymentStatus: c.pay,
      firstSeenAt: c.first === null ? null : at(c.first),
      lastSeenAt: c.last === null ? null : at(c.last),
    })),
  );

  await b.db.insert(s.lifecycleTransitions).values(
    TRANSITIONS.map((t) => ({
      id: randomUUID(),
      tenantId,
      contactId: contactIds[0],
      fromState: t.from,
      toState: t.to,
      transitionedAt: at(t.ago),
    })),
  );

  const flowIds = { A: randomUUID(), B: randomUUID() };
  await b.db.insert(s.flows).values([
    { id: flowIds.A, tenantId, name: "Flow A", triggerType: "manual", triggerConfig: {}, steps: [] },
    { id: flowIds.B, tenantId, name: "Flow B", triggerType: "manual", triggerConfig: {}, steps: [] },
  ]);
  const membershipIds = MESSAGES.map(() => randomUUID());
  await b.db.insert(s.flowMemberships).values(
    MESSAGES.map((m, i) => ({
      id: membershipIds[i],
      tenantId,
      contactId: contactIds[0],
      flowId: flowIds[m.flow],
      status: "completed",
      enteredAt: at(m.createdAgo + H),
    })),
  );
  const messageIds = MESSAGES.map(() => randomUUID());
  // One row per statement: a multi-row insert would pass D1's limit of 100 bound parameters.
  for (const row of MESSAGES.map((m, i) => ({
      id: messageIds[i],
      tenantId,
      contactId: contactIds[0],
      flowId: flowIds[m.flow],
      membershipId: membershipIds[i],
      flowStepOrder: 1,
      status: m.status,
      feedback: m.feedback,
      sentAt: m.sentAgo === null ? null : at(m.sentAgo),
      createdAt: at(m.createdAgo),
    }))) {
    await b.db.insert(s.lifecycleMessages).values(row);
  }
  await b.db.insert(s.messageEvents).values(
    MESSAGE_EVENTS.map((e) => ({
      id: randomUUID(),
      tenantId,
      messageId: messageIds[e.msg],
      eventType: e.type,
      occurredAt: at(e.ago),
    })),
  );

  // Retention snapshots: 'new'/'active' on several UTC days, plus another cell.
  const todayUtc = Math.floor(now / D) * D;
  const snap = (daysBack: number, tenure: string, recency: string, count: number) => ({
    tenantId,
    snapshotDate: utcDay(todayUtc - daysBack * D),
    tenureBucket: tenure,
    recencyBucket: recency,
    contactCount: count,
    payingCount: count - 1,
  });
  await b.db
    .insert(s.retentionGridSnapshots)
    .values([
      snap(0, "new", "active", 10),
      snap(1, "new", "active", 9),
      snap(5, "new", "active", 8),
      snap(30, "new", "active", 7),
      snap(31, "new", "active", 6),
      snap(1, "loyal", "dormant", 3),
    ]);

  return { tenantId, now, contactIds, flowIds };
}

/** Timestamp as ms: pg raw SQL returns text ("2026-01-02 03:04:05.678+00"), d1 a Date. */
function ms(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  return Date.parse(String(v).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
}

const bySortKey = <T>(key: (r: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));

for (const factory of testBackends()) {
  describe(`apiAnalytics on ${factory.name}`, () => {
    let b: Backend;
    let f: Seeded;
    const WINDOW = 30;
    beforeAll(async () => {
      b = await factory.open();
      f = await seed(b);
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const inWindow = (ago: number) => ago <= WINDOW * D;

    it("getTenantSettings returns the settings JSON, null for an unknown tenant", async () => {
      expect(await b.store.apiAnalytics.getTenantSettings({ tenantId: f.tenantId })).toEqual({
        lifecycle: { natural_frequency_days: 7 },
      });
      const empty = await b.newTenant();
      expect(await b.store.apiAnalytics.getTenantSettings({ tenantId: empty })).toBeNull();
      expect(await b.store.apiAnalytics.getTenantSettings({ tenantId: randomUUID() })).toBeNull();
    });

    it("lifecycleDistribution counts states split by depth", async () => {
      const rows = await b.store.apiAnalytics.lifecycleDistribution({ tenantId: f.tenantId });
      expect([...rows].sort(bySortKey((r) => r.state))).toEqual([
        { state: "at_risk", total: 2, power: 0, regular: 0, casual: 1, minimal: 0, unset: 1 },
        { state: "churned", total: 1, power: 0, regular: 0, casual: 0, minimal: 1, unset: 0 },
        { state: "engaged", total: 2, power: 1, regular: 1, casual: 0, minimal: 0, unset: 0 },
      ]);
    });

    it("movementPerState counts entries and exits within the window", async () => {
      const exp = new Map<string, { entered: number; exited: number }>();
      for (const t of TRANSITIONS.filter((t) => inWindow(t.ago))) {
        const to = exp.get(t.to) ?? { entered: 0, exited: 0 };
        to.entered++;
        exp.set(t.to, to);
        const from = exp.get(t.from) ?? { entered: 0, exited: 0 };
        from.exited++;
        exp.set(t.from, from);
      }
      const expected = [...exp].map(([state, v]) => ({ state, ...v })).sort(bySortKey((r) => r.state));
      const rows = await b.store.apiAnalytics.movementPerState({ tenantId: f.tenantId, days: WINDOW });
      expect([...rows].sort(bySortKey((r) => r.state))).toEqual(expected);
      expect(rows.find((r) => r.state === "at_risk")).toEqual({ state: "at_risk", entered: 3, exited: 1 });
    });

    it("movementEdges lists edges by frequency", async () => {
      const rows = await b.store.apiAnalytics.movementEdges({ tenantId: f.tenantId, days: WINDOW });
      expect(rows[0]).toEqual({ from_state: "engaged", to_state: "at_risk", count: 3 });
      const counts = new Map<string, number>();
      for (const t of TRANSITIONS.filter((t) => inWindow(t.ago))) {
        counts.set(`${t.from}>${t.to}`, (counts.get(`${t.from}>${t.to}`) ?? 0) + 1);
      }
      const expected = [...counts]
        .map(([k, count]) => ({ from_state: k.split(">")[0], to_state: k.split(">")[1], count }))
        .sort(bySortKey((r) => `${r.from_state}>${r.to_state}`));
      expect([...rows].sort(bySortKey((r) => `${r.from_state}>${r.to_state}`))).toEqual(expected);
      for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.count).toBeGreaterThanOrEqual(rows[i]!.count);
      expect(await b.store.apiAnalytics.movementEdges({ tenantId: f.tenantId, days: 1 })).toEqual([]);
    });

    it("movementDays buckets transitions by UTC day", async () => {
      const exp = new Map<string, { count: number; positive: number; negative: number }>();
      for (const t of TRANSITIONS.filter((t) => inWindow(t.ago))) {
        const day = utcDay(f.now - t.ago);
        const e = exp.get(day) ?? { count: 0, positive: 0, negative: 0 };
        e.count++;
        if (POSITIVE.includes(t.to)) e.positive++;
        if (NEGATIVE.includes(t.to)) e.negative++;
        exp.set(day, e);
      }
      const expected = [...exp].map(([day, v]) => ({ day, ...v })).sort(bySortKey((r) => r.day));
      expect(expected.length).toBeGreaterThan(2);
      expect(await b.store.apiAnalytics.movementDays({ tenantId: f.tenantId, days: WINDOW })).toEqual(expected);
    });

    it("sendDays counts sends per UTC day on sent_at", async () => {
      const exp = new Map<string, number>();
      for (const m of MESSAGES) {
        if (m.sentAgo === null || !inWindow(m.sentAgo)) continue;
        const day = utcDay(f.now - m.sentAgo);
        exp.set(day, (exp.get(day) ?? 0) + 1);
      }
      const expected = [...exp].map(([day, sent]) => ({ day, sent })).sort(bySortKey((r) => r.day));
      expect(await b.store.apiAnalytics.sendDays({ tenantId: f.tenantId, days: WINDOW })).toEqual(expected);
    });

    it("sendingTotals counts outcomes of messages created in the window", async () => {
      expect(await b.store.apiAnalytics.sendingTotals({ tenantId: f.tenantId, days: WINDOW })).toEqual({
        sent: 4,
        opened: 2,
        clicked: 1,
        bounced: 1,
        complained: 1,
        suppressed: 1,
        failed: 1,
      });
      const empty = await b.newTenant();
      expect(await b.store.apiAnalytics.sendingTotals({ tenantId: empty, days: WINDOW })).toEqual({
        sent: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        complained: 0,
        suppressed: 0,
        failed: 0,
      });
    });

    it("sendingPerFlow splits outcomes per flow, most sent first", async () => {
      expect(await b.store.apiAnalytics.sendingPerFlow({ tenantId: f.tenantId, days: WINDOW })).toEqual([
        {
          flow_id: f.flowIds.A,
          flow_name: "Flow A",
          sent: 3,
          opened: 2,
          clicked: 1,
          bounced: 1,
          complained: 0,
          suppressed: 0,
          failed: 0,
        },
        {
          flow_id: f.flowIds.B,
          flow_name: "Flow B",
          sent: 1,
          opened: 0,
          clicked: 0,
          bounced: 0,
          complained: 1,
          suppressed: 1,
          failed: 1,
        },
      ]);
    });

    it("engagementDays counts opens, clicks and bounces per UTC day", async () => {
      const exp = new Map<string, { opens: number; clicks: number; bounces: number }>();
      for (const e of MESSAGE_EVENTS) {
        if (!inWindow(e.ago) || !["opened", "clicked", "bounced"].includes(e.type)) continue;
        const day = utcDay(f.now - e.ago);
        const v = exp.get(day) ?? { opens: 0, clicks: 0, bounces: 0 };
        if (e.type === "opened") v.opens++;
        if (e.type === "clicked") v.clicks++;
        if (e.type === "bounced") v.bounces++;
        exp.set(day, v);
      }
      const expected = [...exp].map(([day, v]) => ({ day, ...v })).sort(bySortKey((r) => r.day));
      expect(await b.store.apiAnalytics.engagementDays({ tenantId: f.tenantId, days: WINDOW })).toEqual(expected);
    });

    it("earliestEngagementDay is the UTC day of the first message event, null when none", async () => {
      expect(await b.store.apiAnalytics.earliestEngagementDay({ tenantId: f.tenantId })).toBe(
        utcDay(f.now - 50 * D),
      );
      const empty = await b.newTenant();
      expect(await b.store.apiAnalytics.earliestEngagementDay({ tenantId: empty })).toBeNull();
    });

    it("retentionGridCells buckets contacts by tenure and recency", async () => {
      const rows = await b.store.apiAnalytics.retentionGridCells({
        tenantId: f.tenantId,
        tenureThresholdsDays: TENURE,
        recencyThresholdsDays: RECENCY,
      });
      expect([...rows].sort(bySortKey((r) => `${r.tenure}/${r.recency}`))).toEqual([
        { tenure: "established", recency: "idle", count: 1, paying: 1 },
        { tenure: "growing", recency: "cooling", count: 1, paying: 0 },
        { tenure: "loyal", recency: "dormant", count: 2, paying: 0 },
        { tenure: "new", recency: "active", count: 1, paying: 1 },
      ]);
    });

    it("retentionCellContacts lists one cell, paginated by id", async () => {
      const cell = await b.store.apiAnalytics.retentionCellContacts({
        tenantId: f.tenantId,
        tenure: { minDays: 90, maxDays: 365 },
        recency: { minDays: 30, maxDays: 90 },
        afterId: null,
        limit: 10,
      });
      expect(cell.map((r) => ({ ...r, first_seen_at: ms(r.first_seen_at), last_seen_at: ms(r.last_seen_at) }))).toEqual([
        {
          id: f.contactIds[2],
          external_id: "u2",
          email: "u2@example.com",
          name: "User 2",
          lifecycle_state: "at_risk",
          payment_status: "past_due",
          first_seen_at: f.now - 200 * D,
          last_seen_at: f.now - 50 * D,
        },
      ]);

      // Open-ended ranges: every contact with both timestamps, id ascending.
      const all = [...f.contactIds.slice(0, 4)].sort();
      const open = { minDays: 0, maxDays: null };
      const p1 = await b.store.apiAnalytics.retentionCellContacts({
        tenantId: f.tenantId, tenure: open, recency: open, afterId: null, limit: 3,
      });
      expect(p1.map((r) => r.id)).toEqual(all.slice(0, 3));
      const p2 = await b.store.apiAnalytics.retentionCellContacts({
        tenantId: f.tenantId, tenure: open, recency: open, afterId: p1[2]!.id, limit: 3,
      });
      expect(p2.map((r) => r.id)).toEqual(all.slice(3));
    });

    it("audience splits distribution, movement and cell contacts by current payment status", async () => {
      // Own tenant: one contact per payment status, each with its own transitions.
      const s = b.schema as any;
      const now = Date.now();
      const tenantId = await b.newTenant("Audience");
      const defs = [
        { pay: "paid", state: "engaged", tx: [["signed_up", "activated"], ["activated", "engaged"]] },
        { pay: "past_due", state: "at_risk", tx: [["engaged", "at_risk"]] },
        { pay: "free", state: "engaged", tx: [["signed_up", "activated"]] },
        { pay: "trial", state: "dormant", tx: [["at_risk", "dormant"], ["engaged", "at_risk"]] },
        { pay: null, state: "churned", tx: [["dormant", "churned"]] },
      ] as const;
      const ids = defs.map(() => randomUUID());
      await b.db.insert(s.contacts).values(
        defs.map((c, i) => ({
          id: ids[i],
          tenantId,
          externalId: `a${i}`,
          lifecycleState: c.state,
          paymentStatus: c.pay,
          firstSeenAt: new Date(now - 3 * D),
          lastSeenAt: new Date(now - H),
        })),
      );
      await b.db.insert(s.lifecycleTransitions).values(
        defs.flatMap((c, i) =>
          c.tx.map(([from, to], j) => ({
            id: randomUUID(),
            tenantId,
            contactId: ids[i],
            fromState: from,
            toState: to,
            transitionedAt: new Date(now - (j + 1) * H),
          })),
        ),
      );
      // A paying contact in another tenant: its transitions never leak in.
      const other = await b.newTenant("Audience other");
      const otherId = randomUUID();
      await b.db.insert(s.contacts).values({
        id: otherId, tenantId: other, externalId: "o", lifecycleState: "engaged", paymentStatus: "paid",
      });
      await b.db.insert(s.lifecycleTransitions).values({
        id: randomUUID(), tenantId: other, contactId: otherId, fromState: "signed_up", toState: "activated",
        transitionedAt: new Date(now - H),
      });

      const a = b.store.apiAnalytics;
      const total = (rows: Array<{ total: number }>) => rows.reduce((n, r) => n + r.total, 0);
      expect(total(await a.lifecycleDistribution({ tenantId }))).toBe(5);
      expect(total(await a.lifecycleDistribution({ tenantId, audience: "all" }))).toBe(5);
      expect(
        (await a.lifecycleDistribution({ tenantId, audience: "paid" }))
          .map((r) => [r.state, r.total]).sort(),
      ).toEqual([["at_risk", 1], ["engaged", 1]]);
      expect(
        (await a.lifecycleDistribution({ tenantId, audience: "free" }))
          .map((r) => [r.state, r.total]).sort(),
      ).toEqual([["churned", 1], ["dormant", 1], ["engaged", 1]]);

      const edges = async (audience?: "all" | "paid" | "free") =>
        (await a.movementEdges({ tenantId, days: 7, audience }))
          .map((e) => `${e.from_state}>${e.to_state}:${e.count}`).sort();
      expect(await edges("paid")).toEqual(["activated>engaged:1", "engaged>at_risk:1", "signed_up>activated:1"]);
      expect(await edges("free")).toEqual(
        ["at_risk>dormant:1", "dormant>churned:1", "engaged>at_risk:1", "signed_up>activated:1"],
      );
      expect(await edges()).toEqual(
        ["activated>engaged:1", "at_risk>dormant:1", "dormant>churned:1", "engaged>at_risk:2", "signed_up>activated:2"],
      );

      const perState = async (audience: "paid" | "free") =>
        Object.fromEntries(
          (await a.movementPerState({ tenantId, days: 7, audience })).map((r) => [r.state, [r.entered, r.exited]]),
        );
      expect(await perState("paid")).toEqual({
        signed_up: [0, 1], activated: [1, 1], engaged: [1, 1], at_risk: [1, 0],
      });
      expect(await perState("free")).toEqual({
        signed_up: [0, 1], activated: [1, 0], engaged: [0, 1], at_risk: [1, 1], dormant: [1, 1], churned: [1, 0],
      });

      const dayTotals = async (audience: "all" | "paid" | "free") => {
        const rows = await a.movementDays({ tenantId, days: 7, audience });
        return rows.reduce(
          (t, r) => ({ count: t.count + r.count, positive: t.positive + r.positive, negative: t.negative + r.negative }),
          { count: 0, positive: 0, negative: 0 },
        );
      };
      expect(await dayTotals("paid")).toEqual({ count: 3, positive: 2, negative: 1 });
      expect(await dayTotals("free")).toEqual({ count: 4, positive: 1, negative: 3 });
      expect(await dayTotals("all")).toEqual({ count: 7, positive: 3, negative: 4 });

      const open = { minDays: 0, maxDays: null };
      const cell = async (audience: "all" | "paid" | "free") =>
        (await a.retentionCellContacts({ tenantId, tenure: open, recency: open, afterId: null, limit: 10, audience }))
          .map((r) => r.payment_status).sort();
      expect(await cell("paid")).toEqual(["paid", "past_due"]);
      expect(await cell("free")).toEqual(["free", null, "trial"].sort());
      expect(await cell("all")).toHaveLength(5);
    });

    it("retentionCellTrend returns the cell's snapshots in the last N UTC days, oldest first", async () => {
      const todayUtc = Math.floor(Date.now() / D) * D;
      expect(
        await b.store.apiAnalytics.retentionCellTrend({
          tenantId: f.tenantId, tenure: "new", recency: "active", days: 30,
        }),
      ).toEqual([
        { day: utcDay(todayUtc - 5 * D), count: 8, paying: 7 },
        { day: utcDay(todayUtc - 1 * D), count: 9, paying: 8 },
        { day: utcDay(todayUtc), count: 10, paying: 9 },
      ]);
      expect(
        await b.store.apiAnalytics.retentionCellTrend({
          tenantId: f.tenantId, tenure: "loyal", recency: "dormant", days: 1,
        }),
      ).toEqual([]);
    });
  });
}
