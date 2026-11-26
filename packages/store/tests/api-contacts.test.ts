/**
 * Contract tests for the apiContacts store area, on every backend.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";

const H = 3_600_000;
const D = 86_400_000;

/** Timestamp as ms: pg raw SQL returns text ("2026-01-02 03:04:05.678+00"), d1 a Date. */
function ms(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  return Date.parse(String(v).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
}

/** Copy of a row with the given timestamp columns as ms. */
function norm<T extends Record<string, unknown>>(row: T, cols: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const c of cols) out[c] = ms(row[c]);
  return out;
}

/** The cursor string the API would encode from a row's timestamp. */
function iso(v: unknown): string {
  return new Date(ms(v)!).toISOString();
}

interface ContactDef {
  id: string;
  externalId: string;
  email: string | null;
  name: string | null;
  state: string;
  depth: string | null;
  firstAgo: number | null;
  lastAgo: number | null;
  createdAgo: number;
  payment?: string;
}

for (const factory of testBackends()) {
  describe(`apiContacts on ${factory.name}`, () => {
    let b: Backend;
    let s: any;
    let tenantId: string;
    let now: number;
    let contacts: ContactDef[];
    // Expected newest-first order: created_at DESC, id DESC
    let ordered: ContactDef[];

    beforeAll(async () => {
      b = await factory.open();
      s = b.schema;
      now = Date.now();
      tenantId = await b.newTenant("Contacts");
      await b.db
        .update(s.tenants)
        .set({ settings: { lifecycle: { natural_frequency_days: 14 }, flag: null } })
        .where(eq(s.tenants.id, tenantId));

      const def = (
        i: number,
        o: Partial<ContactDef> & { createdAgo: number },
      ): ContactDef => ({
        id: randomUUID(),
        externalId: `ext-${i}`,
        email: `person${i}@example.com`,
        name: `Person ${i}`,
        state: "engaged",
        depth: "regular",
        firstAgo: 10 * D,
        lastAgo: 1 * D,
        ...o,
      });
      contacts = [
        def(0, { createdAgo: 1 * H, email: "Alice@ACME.io", name: "Alice" }),
        def(1, { createdAgo: 2 * H, state: "at_risk", depth: "casual", lastAgo: 40 * D }),
        // two contacts with the same created_at: id breaks the tie
        def(2, { createdAgo: 3 * H, name: "Bob Acme", firstAgo: 100 * D }),
        def(3, { createdAgo: 3 * H, externalId: "acme-ext", depth: null, firstAgo: 100 * D, lastAgo: 5 * D }),
        def(4, { createdAgo: 4 * H, email: null, name: null, state: "churned", depth: "minimal", firstAgo: null, lastAgo: null }),
        // a blank name falls back to the email; a non-ASCII initial files under "#"
        def(5, { createdAgo: 5 * H, email: "Zed@example.com", name: "  ", depth: "power", firstAgo: null, lastAgo: null }),
        def(6, { createdAgo: 6 * H, name: "\u00c9mile", depth: "power", firstAgo: null, lastAgo: null }),
      ];
      contacts[1]!.payment = "paid";
      contacts[2]!.payment = "trial";
      // One row per insert: D1 binds at most 100 parameters per statement.
      for (const c of contacts) {
        await b.db.insert(s.contacts).values({
          id: c.id,
          tenantId,
          externalId: c.externalId,
          email: c.email,
          name: c.name,
          company: "Co",
          properties: { plan: "pro", tags: ["a", "b"], n: 1 },
          lifecycleState: c.state,
          engagementDepth: c.depth,
          paymentStatus: c.payment ?? "free",
          firstSeenAt: c.firstAgo === null ? null : new Date(now - c.firstAgo),
          lastSeenAt: c.lastAgo === null ? null : new Date(now - c.lastAgo),
          createdAt: new Date(now - c.createdAgo),
        });
      }
      ordered = [...contacts].sort((a, c) =>
        a.createdAgo !== c.createdAgo ? a.createdAgo - c.createdAgo : c.id.localeCompare(a.id),
      );
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const emptyFilter = {
      lifecycleState: null,
      engagementDepth: null,
      paymentStatus: null,
      searchPattern: null,
      letter: null,
      tenureMinDays: null,
      tenureMaxDays: null,
      recencyMinDays: null,
      recencyMaxDays: null,
      joinedAfter: null,
      joinedBefore: null,
      lastSeenAfter: null,
      lastSeenBefore: null,
    };
    const newest = { key: "created", order: "desc" } as const;
    const list = (filter: Record<string, unknown>, limit = 50, sort: { key: string; order: string } = newest, after: unknown = null) =>
      b.store.apiContacts.listContacts({
        tenantId,
        filter: { ...emptyFilter, ...filter },
        sort: sort as never,
        after: after as never,
        limit,
      });

    it("getTenantSettings returns settings JSON or null", async () => {
      expect(await b.store.apiContacts.getTenantSettings({ tenantId })).toEqual({
        lifecycle: { natural_frequency_days: 14 },
        flag: null,
      });
      expect(await b.store.apiContacts.getTenantSettings({ tenantId: randomUUID() })).toBeNull();
    });

    it("listContacts returns the newest first with the list columns", async () => {
      const rows = await list({});
      expect(rows.map((r) => r.id)).toEqual(ordered.map((c) => c.id));
      const first = contacts[0]!;
      const { sort_key: _key, ...row } = rows[0]!;
      expect(norm(row, ["first_seen_at", "last_seen_at", "created_at"])).toEqual({
        id: first.id,
        tenant_id: tenantId,
        external_id: first.externalId,
        email: "Alice@ACME.io",
        name: "Alice",
        company: "Co",
        lifecycle_state: "engaged",
        engagement_depth: "regular",
        payment_status: "free",
        first_seen_at: now - first.firstAgo!,
        last_seen_at: now - first.lastAgo!,
        created_at: now - first.createdAgo,
      });
      if (b.name === "d1") expect(rows[0]!.created_at).toBeInstanceOf(Date);
      const nullSeen = rows.find((r) => r.id === contacts[4]!.id)!;
      expect(nullSeen.last_seen_at).toBeNull();
    });

    it("listContacts walks pages with an ISO created_at cursor (cursors from before sorting)", async () => {
      const seen: string[] = [];
      let after: { key: string; id: string } | null = null;
      for (let page = 0; page < 10; page++) {
        const rows = await list({}, 2, newest, after);
        seen.push(...rows.map((r) => r.id));
        if (rows.length < 2) break;
        const last = rows[rows.length - 1]!;
        after = { key: iso(last.created_at), id: last.id };
      }
      expect(seen).toEqual(ordered.map((c) => c.id));
    });

    it("listContacts sorts by created, name, joined and last seen, both ways, and pages each with sort_key", async () => {
      const byId = (a: ContactDef, c: ContactDef) => (a.id < c.id ? 1 : a.id > c.id ? -1 : 0);
      // Descending orders, ties broken by id DESC.
      const joinedDesc = [...contacts]
        .sort((a, c) => (a.firstAgo ?? a.createdAgo) - (c.firstAgo ?? c.createdAgo) || byId(a, c))
        .map((c) => c.id);
      const lastSeenDesc = [...contacts]
        .sort((a, c) => (a.lastAgo ?? Infinity) - (c.lastAgo ?? Infinity) || byId(a, c))
        .map((c) => c.id);
      // alice, bob acme, ext-4, person 1, person 3, zed@example.com, Emile (non-ASCII last in byte order)
      const nameAsc = [0, 2, 4, 1, 3, 5, 6].map((i) => contacts[i]!.id);
      const expected: Record<string, string[]> = {
        "created desc": ordered.map((c) => c.id),
        "created asc": ordered.map((c) => c.id).reverse(),
        "name asc": nameAsc,
        "name desc": [...nameAsc].reverse(),
        "joined desc": joinedDesc,
        "joined asc": [...joinedDesc].reverse(),
        "last_seen desc": lastSeenDesc,
        "last_seen asc": [...lastSeenDesc].reverse(),
      };
      for (const [label, ids] of Object.entries(expected)) {
        const [key, order] = label.split(" ") as [string, string];
        const sort = { key, order };
        expect((await list({}, 50, sort)).map((r) => r.id), label).toEqual(ids);
        const seen: string[] = [];
        let after: { key: string | number; id: string } | null = null;
        for (let page = 0; page < 10; page++) {
          const rows = await list({}, 2, sort, after);
          seen.push(...rows.map((r) => r.id));
          if (rows.length < 2) break;
          const last = rows[rows.length - 1]!;
          after = { key: last.sort_key, id: last.id };
        }
        expect(seen, `${label} paged`).toEqual(ids);
      }
      // A sort combines with filters.
      expect((await list({ lifecycleState: "engaged" }, 50, { key: "name", order: "asc" })).map((r) => r.id)).toEqual(
        nameAsc.filter((id) => id !== contacts[1]!.id && id !== contacts[4]!.id),
      );
    });

    it("listContacts filters by payment status, first letter and date ranges", async () => {
      const ids = async (filter: Record<string, unknown>) => (await list(filter)).map((r) => r.id).sort();
      const idsOf = (...i: number[]) => i.map((n) => contacts[n]!.id).sort();
      expect(await ids({ paymentStatus: "paid" })).toEqual(idsOf(1));
      expect(await ids({ paymentStatus: "free" })).toEqual(idsOf(0, 3, 4, 5, 6));
      expect(await ids({ paymentStatus: "cancelled" })).toEqual([]);
      // display names: alice, person 1, bob acme, person 3, ext-4, zed@example.com (blank name), Emile
      expect(await ids({ letter: "p" })).toEqual(idsOf(1, 3));
      expect(await ids({ letter: "a" })).toEqual(idsOf(0));
      expect(await ids({ letter: "e" })).toEqual(idsOf(4));
      expect(await ids({ letter: "z" })).toEqual(idsOf(5));
      expect(await ids({ letter: "#" })).toEqual(idsOf(6));
      expect(await ids({ letter: "x" })).toEqual([]);
      expect(await ids({ letter: "p", paymentStatus: "paid" })).toEqual(idsOf(1));
      const at = (agoMs: number) => new Date(now - agoMs).toISOString();
      // joined = first seen, else created: 0, 1 at 10d; 2, 3 at 100d; 4, 5, 6 hours ago
      expect(await ids({ joinedAfter: at(50 * D) })).toEqual(idsOf(0, 1, 4, 5, 6));
      expect(await ids({ joinedBefore: at(50 * D) })).toEqual(idsOf(2, 3));
      expect(await ids({ joinedAfter: at(50 * D), joinedBefore: at(1 * D) })).toEqual(idsOf(0, 1));
      // after is inclusive, before exclusive
      expect(await ids({ joinedAfter: at(100 * D), joinedBefore: at(100 * D) })).toEqual([]);
      expect(await ids({ joinedAfter: at(100 * D), joinedBefore: at(99 * D) })).toEqual(idsOf(2, 3));
      // last seen: 0, 2 at 1d; 3 at 5d; 1 at 40d; 4, 5, 6 never (excluded by any range)
      expect(await ids({ lastSeenAfter: at(3 * D) })).toEqual(idsOf(0, 2));
      expect(await ids({ lastSeenBefore: at(3 * D) })).toEqual(idsOf(1, 3));
      expect(await ids({ lastSeenAfter: at(10 * D), lastSeenBefore: at(3 * D) })).toEqual(idsOf(3));
    });

    it("listContacts filters by state, depth and case-insensitive search", async () => {
      const ids = async (filter: Partial<typeof emptyFilter> & Record<string, unknown>) =>
        (await list(filter)).map((r) => r.id).sort();
      const idsOf = (...i: number[]) => i.map((n) => contacts[n]!.id).sort();

      expect(await ids({ lifecycleState: "at_risk" })).toEqual(idsOf(1));
      expect(await ids({ engagementDepth: "minimal" })).toEqual(idsOf(4));
      // email "Alice@ACME.io", name "Bob Acme", external_id "acme-ext"
      expect(await ids({ searchPattern: "%acme%" })).toEqual(idsOf(0, 2, 3));
      expect(await ids({ searchPattern: "%ALICE%" })).toEqual(idsOf(0));
      expect(await ids({ searchPattern: "%nobody%" })).toEqual([]);
      expect(await ids({ lifecycleState: "engaged", searchPattern: "%acme%", engagementDepth: "regular" })).toEqual(
        idsOf(0, 2),
      );
    });

    it("listContacts filters by tenure and recency day ranges", async () => {
      const ids = async (filter: Record<string, unknown>) => (await list(filter)).map((r) => r.id).sort();
      const idsOf = (...i: number[]) => i.map((n) => contacts[n]!.id).sort();
      // first_seen 10d ago: 0, 1; 100d ago: 2, 3; null: 4
      expect(await ids({ tenureMinDays: 30 })).toEqual(idsOf(2, 3));
      expect(await ids({ tenureMaxDays: 30 })).toEqual(idsOf(0, 1));
      expect(await ids({ tenureMinDays: 5, tenureMaxDays: 30 })).toEqual(idsOf(0, 1));
      // last_seen 1d: 0, 2; 40d: 1; 5d: 3
      expect(await ids({ recencyMinDays: 3 })).toEqual(idsOf(1, 3));
      expect(await ids({ recencyMinDays: 3, recencyMaxDays: 30 })).toEqual(idsOf(3));
      expect(await ids({ recencyMaxDays: 2 })).toEqual(idsOf(0, 2));
      expect(await ids({ tenureMinDays: 30, recencyMinDays: 3 })).toEqual(idsOf(3));
    });

    it("countContactsByInitial counts matches per initial with every filter but the letter", async () => {
      const counts = async (filter: Record<string, unknown>) => {
        const out: Record<string, number> = {};
        const rows = await b.store.apiContacts.countContactsByInitial({ tenantId, filter: { ...emptyFilter, ...filter } });
        // Non-ASCII initials come back as the backend lowercases them; the API files them under "#".
        for (const { initial, n } of rows) {
          const l = /^[a-z]$/.test(initial) ? initial : "#";
          out[l] = (out[l] ?? 0) + n;
        }
        return out;
      };
      expect(await counts({})).toEqual({ a: 1, b: 1, e: 1, p: 2, z: 1, "#": 1 });
      // the letter filter is ignored, the others apply
      expect(await counts({ letter: "p" })).toEqual({ a: 1, b: 1, e: 1, p: 2, z: 1, "#": 1 });
      expect(await counts({ searchPattern: "%acme%" })).toEqual({ a: 1, b: 1, p: 1 });
      expect(await counts({ lifecycleState: "engaged", engagementDepth: "regular" })).toEqual({ a: 1, b: 1 });
      expect(await counts({ tenureMinDays: 30, recencyMinDays: 3 })).toEqual({ p: 1 });
      expect(await counts({ paymentStatus: "trial" })).toEqual({ b: 1 });
      expect(await counts({ searchPattern: "%nobody%" })).toEqual({});
      expect(
        await b.store.apiContacts.countContactsByInitial({ tenantId: randomUUID(), filter: emptyFilter }),
      ).toEqual([]);
    });

    it("getContact returns the full row with parsed properties, null when absent", async () => {
      const c = contacts[0]!;
      const row = await b.store.apiContacts.getContact({ tenantId, contactId: c.id });
      expect(norm(row!, ["first_seen_at", "last_seen_at", "activated_at", "created_at"])).toEqual({
        id: c.id,
        tenant_id: tenantId,
        external_id: c.externalId,
        email: c.email,
        name: c.name,
        company: "Co",
        properties: { plan: "pro", tags: ["a", "b"], n: 1 },
        lifecycle_state: "engaged",
        engagement_depth: "regular",
        payment_status: "free",
        first_seen_at: now - c.firstAgo!,
        last_seen_at: now - c.lastAgo!,
        activated_at: null,
        created_at: now - c.createdAgo,
      });
      expect(await b.store.apiContacts.getContact({ tenantId, contactId: randomUUID() })).toBeNull();
      const other = await b.newTenant();
      expect(await b.store.apiContacts.getContact({ tenantId: other, contactId: c.id })).toBeNull();
    });

    it("contactExists is tenant scoped", async () => {
      const id = contacts[1]!.id;
      expect(await b.store.apiContacts.contactExists({ tenantId, contactId: id })).toBe(true);
      expect(await b.store.apiContacts.contactExists({ tenantId, contactId: randomUUID() })).toBe(false);
      const other = await b.newTenant();
      expect(await b.store.apiContacts.contactExists({ tenantId: other, contactId: id })).toBe(false);
    });

    it("findSuppression matches the email case-insensitively", async () => {
      const t = await b.newTenant();
      const id = randomUUID();
      const createdAt = new Date(now - 2 * D);
      await b.db.insert(s.suppressions).values([
        { id, tenantId: t, email: "Bounce@Example.com", reason: "hard_bounce", source: "webhook", createdAt },
      ]);
      const row = await b.store.apiContacts.findSuppression({ tenantId: t, email: "bounce@EXAMPLE.com" });
      expect(norm(row!, ["created_at"])).toEqual({
        id,
        reason: "hard_bounce",
        source: "webhook",
        created_at: createdAt.getTime(),
      });
      expect(await b.store.apiContacts.findSuppression({ tenantId: t, email: "other@example.com" })).toBeNull();
      expect(await b.store.apiContacts.findSuppression({ tenantId, email: "bounce@example.com" })).toBeNull();
    });

    it("listContactMemberships lists memberships with flow names, newest entry first", async () => {
      const c = contacts[2]!;
      const flowA = randomUUID();
      const flowB = randomUUID();
      await b.db.insert(s.flows).values([
        { id: flowA, tenantId, name: "Onboarding", triggerType: "manual", triggerConfig: {}, steps: [] },
        { id: flowB, tenantId, name: "Winback", triggerType: "manual", triggerConfig: {}, steps: [] },
      ]);
      const m1 = randomUUID();
      const m2 = randomUUID();
      await b.db.insert(s.flowMemberships).values([
        {
          id: m1, tenantId, contactId: c.id, flowId: flowA, status: "completed", currentStep: 3,
          enteredAt: new Date(now - 20 * D), completedAt: new Date(now - 10 * D), exitReason: "completed",
        },
        { id: m2, tenantId, contactId: c.id, flowId: flowB, status: "active", enteredAt: new Date(now - 2 * D) },
      ]);
      const rows = await b.store.apiContacts.listContactMemberships({ tenantId, contactId: c.id });
      expect(rows.map((r) => norm(r, ["entered_at", "completed_at", "exited_at"]))).toEqual([
        {
          id: m2, flow_id: flowB, flow_name: "Winback", status: "active", current_step: 1,
          entered_at: now - 2 * D, completed_at: null, exited_at: null, exit_reason: null,
        },
        {
          id: m1, flow_id: flowA, flow_name: "Onboarding", status: "completed", current_step: 3,
          entered_at: now - 20 * D, completed_at: now - 10 * D, exited_at: null, exit_reason: "completed",
        },
      ]);
      expect(await b.store.apiContacts.listContactMemberships({ tenantId, contactId: contacts[1]!.id })).toEqual([]);
    });

    it("listContactTimeline merges events, transitions and messages with per-branch cursors", async () => {
      const t = await b.newTenant();
      const cid = randomUUID();
      await b.db.insert(s.contacts).values({
        id: cid, tenantId: t, externalId: "tl", lifecycleState: "engaged",
      });
      const flowId = randomUUID();
      await b.db.insert(s.flows).values({
        id: flowId, tenantId: t, name: "Nurture", triggerType: "manual", triggerConfig: {}, steps: [],
      });
      const memberships = [randomUUID(), randomUUID(), randomUUID()];
      await b.db.insert(s.flowMemberships).values(
        memberships.map((id) => ({
          id, tenantId: t, contactId: cid, flowId, status: "completed", enteredAt: new Date(now - 30 * D),
        })),
      );

      type Item = { kind: string; id: string; at: number };
      const items: Item[] = [];
      // A shared timestamp across all three branches exercises the id tiebreak.
      const tie = now - 5 * H;
      const eventAts = [now - 1 * H, tie, now - 7 * H, now - 2 * D, tie];
      const events = eventAts.map((at, i) => ({
        id: randomUUID(), tenantId: t, contactId: cid, type: i === 0 ? "identify" : "track",
        eventName: i === 0 ? null : `ev_${i}`, properties: { i }, context: { ip: "1.2.3.4" }, timestamp: new Date(at),
      }));
      await b.db.insert(s.events).values(events);
      events.forEach((e) => items.push({ kind: "event", id: e.id, at: e.timestamp.getTime() }));

      const trAts = [now - 2 * H, tie, now - 3 * D];
      const transitions = trAts.map((at) => ({
        id: randomUUID(), tenantId: t, contactId: cid, fromState: "activated", toState: "engaged",
        metadata: { reason: "x" }, transitionedAt: new Date(at),
      }));
      await b.db.insert(s.lifecycleTransitions).values(transitions);
      transitions.forEach((r) => items.push({ kind: "transition", id: r.id, at: r.transitionedAt.getTime() }));

      // Message 0 is sent; message 1 never sent (falls back to created_at); message 2 ties.
      const msgs = [
        { sentAt: new Date(now - 4 * H), createdAt: new Date(now - 6 * D) },
        { sentAt: null, createdAt: new Date(now - 30 * H) },
        { sentAt: new Date(tie), createdAt: new Date(now - 6 * D) },
      ].map((m, i) => ({
        id: randomUUID(), tenantId: t, contactId: cid, flowId, membershipId: memberships[i]!, flowStepOrder: i + 1,
        status: m.sentAt ? "sent" : "pending_approval", feedback: i === 0 ? "opened" : null,
        subject: `Subject ${i}`, ...m,
      }));
      await b.db.insert(s.lifecycleMessages).values(msgs);
      msgs.forEach((m) => items.push({ kind: "message", id: m.id, at: (m.sentAt ?? m.createdAt).getTime() }));

      // Noise: another contact's rows are not included.
      const other = randomUUID();
      await b.db.insert(s.contacts).values({ id: other, tenantId: t, externalId: "other", lifecycleState: "engaged" });
      await b.db.insert(s.events).values({
        id: randomUUID(), tenantId: t, contactId: other, type: "track", eventName: "x", timestamp: new Date(now),
      });

      const expected = [...items].sort((a, c) => (a.at !== c.at ? c.at - a.at : c.id.localeCompare(a.id)));

      const full = await b.store.apiContacts.listContactTimeline({ tenantId: t, contactId: cid, before: null, limit: 50 });
      expect(full.map((r) => [r.kind, r.id, ms(r.occurred_at)])).toEqual(expected.map((e) => [e.kind, e.id, e.at]));
      if (b.name === "d1") expect(full[0]!.occurred_at).toBeInstanceOf(Date);

      const ev = full.find((r) => r.id === events[1]!.id)!;
      expect(norm(ev, ["occurred_at"])).toEqual({
        kind: "event", id: events[1]!.id, occurred_at: tie, event_type: "track", event_name: "ev_1",
        properties: { i: 1 }, from_state: null, to_state: null, subject: null, status: null, feedback: null,
        flow_id: null, flow_name: null, flow_step_order: null, context: { ip: "1.2.3.4" }, metadata: null,
      });
      const tr = full.find((r) => r.id === transitions[0]!.id)!;
      expect(norm(tr, ["occurred_at"])).toEqual({
        kind: "transition", id: transitions[0]!.id, occurred_at: trAts[0], event_type: null, event_name: null,
        properties: null, from_state: "activated", to_state: "engaged", subject: null, status: null, feedback: null,
        flow_id: null, flow_name: null, flow_step_order: null, context: null, metadata: { reason: "x" },
      });
      const msg = full.find((r) => r.id === msgs[1]!.id)!;
      expect(norm(msg, ["occurred_at"])).toEqual({
        kind: "message", id: msgs[1]!.id, occurred_at: now - 30 * H, event_type: null, event_name: null,
        properties: null, from_state: null, to_state: null, subject: "Subject 1", status: "pending_approval",
        feedback: null, flow_id: flowId, flow_name: "Nurture", flow_step_order: 2, context: null, metadata: null,
      });

      // Paging with limit 2 (as the API does: cursor from the last row) yields the same sequence.
      for (const limit of [1, 2, 3]) {
        const seen: string[] = [];
        let before: { occurredAt: string; id: string } | null = null;
        for (let page = 0; page < 20; page++) {
          const rows = await b.store.apiContacts.listContactTimeline({ tenantId: t, contactId: cid, before, limit });
          seen.push(...rows.map((r) => r.id as string));
          if (rows.length < limit) break;
          const last = rows[rows.length - 1]!;
          before = { occurredAt: iso(last.occurred_at), id: last.id as string };
        }
        expect(seen).toEqual(expected.map((e) => e.id));
      }
    });
  });
}
