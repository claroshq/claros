/**
 * Contract tests for the apiSentLog store area, on every backend.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";
import type { SentLogFilter } from "../src/areas/api-sent-log.js";

const H = 3_600_000;
const D = 86_400_000;

/** Timestamp as ms: pg raw SQL returns text ("2026-01-02 03:04:05.678+00"), d1 a Date. */
function ms(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  return Date.parse(String(v).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
}

function norm(row: Record<string, unknown>, cols: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const c of cols) out[c] = ms(row[c]);
  return out;
}

const NO_FILTER: SentLogFilter = {
  status: null,
  flowId: null,
  recipient: null,
  from: null,
  to: null,
  feedback: null,
  before: null,
};

type MsgDef = {
  status: string;
  feedback: string | null;
  sentAgo: number | null;
  flow: 0 | 1;
  contact: 0 | 1;
  recipient: string | null;
};

const MSGS: MsgDef[] = [
  { status: "sent", feedback: "opened", sentAgo: 1 * H, flow: 0, contact: 0, recipient: "ann@example.com" },
  { status: "sent", feedback: "clicked", sentAgo: 5 * H, flow: 0, contact: 1, recipient: "bo@corp.test" },
  { status: "sent", feedback: "bounced", sentAgo: 2 * D, flow: 1, contact: 0, recipient: "ann@example.com" },
  { status: "sent", feedback: "complained", sentAgo: 2 * D, flow: 1, contact: 1, recipient: "bo@corp.test" }, // ties
  { status: "sent", feedback: null, sentAgo: 10 * D, flow: 0, contact: 0, recipient: "ann@example.com" },
  { status: "failed", feedback: null, sentAgo: null, flow: 1, contact: 1, recipient: "bo@corp.test" },
  { status: "sending", feedback: null, sentAgo: null, flow: 0, contact: 0, recipient: null },
  { status: "suppressed", feedback: null, sentAgo: null, flow: 1, contact: 0, recipient: null },
  { status: "approved", feedback: null, sentAgo: null, flow: 0, contact: 1, recipient: null }, // not in the log
  { status: "pending_approval", feedback: null, sentAgo: null, flow: 1, contact: 0, recipient: null },
];

for (const factory of testBackends()) {
  describe(`apiSentLog on ${factory.name}`, () => {
    let b: Backend;
    let tenantId: string;
    let now: number;
    let flowIds: string[];
    let contactIds: string[];
    let msgIds: string[];

    beforeAll(async () => {
      b = await factory.open();
      const s: any = b.schema;
      now = Date.now();
      tenantId = await b.newTenant("SentLog");
      contactIds = [randomUUID(), randomUUID()];
      await b.db.insert(s.contacts).values([
        { id: contactIds[0], tenantId, externalId: "c0", email: "Ann@Example.com", name: "Ann Lee", lifecycleState: "engaged" },
        { id: contactIds[1], tenantId, externalId: "c1", email: "bo@corp.test", name: "Bo Zhang", lifecycleState: "engaged" },
      ]);
      flowIds = [randomUUID(), randomUUID()];
      await b.db.insert(s.flows).values([
        { id: flowIds[0], tenantId, name: "Welcome", triggerType: "manual", triggerConfig: {}, steps: [], compiledPlan: { steps: [{ order: 1, template_ref: "welcome" }] } },
        { id: flowIds[1], tenantId, name: "Winback", triggerType: "manual", triggerConfig: {}, steps: [] },
      ]);
      const memberships = MSGS.map(() => randomUUID());
      await b.db.insert(s.flowMemberships).values(
        MSGS.map((m, i) => ({
          id: memberships[i], tenantId, contactId: contactIds[m.contact], flowId: flowIds[m.flow],
          status: "completed", enteredAt: new Date(now - 30 * D),
        })),
      );
      msgIds = MSGS.map(() => randomUUID());
      // Chunked: D1 allows at most 100 bound parameters per statement.
      const rows = MSGS.map((m, i) => ({
          id: msgIds[i], tenantId, contactId: contactIds[m.contact], flowId: flowIds[m.flow],
          membershipId: memberships[i], flowStepOrder: 1, status: m.status, feedback: m.feedback,
          subject: `S${i}`, bodyHtml: `<p>${i}</p>`, bodyText: `${i}`, recipientAddress: m.recipient,
          sentAt: m.sentAgo === null ? null : new Date(now - m.sentAgo),
          createdAt: new Date(now - 20 * D + i * H),
          updatedAt: new Date(now - 1 * D),
        }));
      for (let i = 0; i < rows.length; i += 4) {
        await b.db.insert(s.lifecycleMessages).values(rows.slice(i, i + 4));
      }
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    /** Expected ids for a predicate, ordered sent_at DESC NULLS LAST, id DESC. */
    function expectedIds(pred: (m: MsgDef) => boolean): string[] {
      return MSGS.map((m, i) => ({ m, id: msgIds[i]! }))
        .filter(({ m }) => ["sending", "sent", "failed", "suppressed"].includes(m.status) && pred(m))
        .sort((a, c) => {
          const at = a.m.sentAgo === null ? null : now - a.m.sentAgo;
          const ct = c.m.sentAgo === null ? null : now - c.m.sentAgo;
          if (at !== ct) {
            if (at === null) return 1;
            if (ct === null) return -1;
            return ct - at;
          }
          return c.id.localeCompare(a.id);
        })
        .map((x) => x.id);
    }

    const list = async (filter: Partial<SentLogFilter>, limit = 50) =>
      b.store.apiSentLog.listSentMessages({ tenantId, filter: { ...NO_FILTER, ...filter }, limit });

    it("listSentMessages lists sent-log statuses newest first, NULL sent_at last, with joins", async () => {
      const rows = await list({});
      expect(rows.map((r) => r.id)).toEqual(expectedIds(() => true));
      const first = rows[0]!;
      expect(norm(first, ["sent_at", "created_at"])).toEqual({
        id: msgIds[0], tenant_id: tenantId, contact_id: contactIds[0], flow_id: flowIds[0], flow_name: "Welcome",
        status: "sent", feedback: "opened", subject: "S0", recipient_address: "ann@example.com",
        sent_at: now - 1 * H, created_at: now - 20 * D,
        contact_email: "Ann@Example.com", contact_name: "Ann Lee", contact_external_id: "c0",
      });
      if (b.name === "d1") expect(first.sent_at).toBeInstanceOf(Date);
      expect(rows.at(-1)!.sent_at).toBeNull();
    });

    it("listSentMessages filters by status, flow, feedback and date range", async () => {
      const ids = async (f: Partial<SentLogFilter>) => (await list(f)).map((r) => r.id);
      expect(await ids({ status: "failed" })).toEqual(expectedIds((m) => m.status === "failed"));
      expect(await ids({ flowId: flowIds[1]! })).toEqual(expectedIds((m) => m.flow === 1));
      expect(await ids({ feedback: "opened" })).toEqual(
        expectedIds((m) => m.feedback === "opened" || m.feedback === "clicked"),
      );
      expect(await ids({ feedback: "bounced" })).toEqual(expectedIds((m) => m.feedback === "bounced"));
      const from = new Date(now - 3 * D).toISOString();
      const to = new Date(now - 2 * H).toISOString();
      expect(await ids({ from, to })).toEqual(
        expectedIds((m) => m.sentAgo !== null && m.sentAgo >= 2 * H && m.sentAgo <= 3 * D),
      );
      // Bounds are inclusive.
      const exact = new Date(now - 10 * D).toISOString();
      expect(await ids({ from: exact, to: exact })).toEqual([msgIds[4]]);
      // A date without time is midnight UTC.
      const tomorrow = new Date(now + D).toISOString().slice(0, 10);
      expect(await ids({ from: tomorrow })).toEqual([]);
    });

    it("listSentMessages searches recipient, contact email and name case-insensitively", async () => {
      const ids = async (recipient: string) => (await list({ recipient })).map((r) => r.id);
      // contact 0's email is Ann@Example.com; recipient_address ann@example.com
      expect(await ids("ANN@EXAMPLE")).toEqual(expectedIds((m) => m.contact === 0));
      // name match only
      expect(await ids("zhang")).toEqual(expectedIds((m) => m.contact === 1));
      // recipient address match (corp.test is also contact 1's email)
      expect(await ids("CORP.TEST")).toEqual(expectedIds((m) => m.contact === 1));
      expect(await ids("nobody")).toEqual([]);
    });

    it("listSentMessages pages with the (sent_at, id) cursor", async () => {
      const all = expectedIds((m) => m.sentAgo !== null);
      const seen: string[] = [];
      let before: { sentAt: string; id: string } | null = null;
      for (let page = 0; page < 10; page++) {
        const rows = await list({ before }, 2);
        seen.push(...rows.map((r) => r.id));
        if (rows.length < 2) break;
        const last = rows[rows.length - 1]!;
        if (last.sent_at === null) break;
        before = { sentAt: new Date(ms(last.sent_at)!).toISOString(), id: last.id };
      }
      // The cursor stops before NULL sent_at rows (row comparison with NULL is not true).
      expect(seen.filter((id) => all.includes(id))).toEqual(all);
      const afterLastSent = await list({ before: { sentAt: new Date(now - 10 * D).toISOString(), id: msgIds[4]! } });
      expect(afterLastSent).toEqual([]);
    });

    it("listSentMessages is tenant scoped", async () => {
      const other = await b.newTenant();
      expect(await b.store.apiSentLog.listSentMessages({ tenantId: other, filter: NO_FILTER, limit: 10 })).toEqual([]);
    });

    it("getSentMessage returns the detail row, null for another tenant or unknown id", async () => {
      const row = await b.store.apiSentLog.getSentMessage({ tenantId, messageId: msgIds[1]! });
      expect(
        norm(row!, ["scheduled_send_at", "approved_at", "sent_at", "created_at", "updated_at"]),
      ).toEqual({
        id: msgIds[1], tenant_id: tenantId, contact_id: contactIds[1], flow_id: flowIds[0], flow_name: "Welcome",
        membership_id: expect.any(String), flow_step_order: 1, status: "sent", feedback: "clicked",
        subject: "S1", body_html: "<p>1</p>", body_text: "1", brain_reasoning: null, brain_action_type: null,
        scheduled_send_at: null, approved_at: null, sent_at: now - 5 * H,
        created_at: now - 20 * D + 1 * H, updated_at: now - 1 * D, retry_count: 0,
        provider_message_id: null, recipient_address: "bo@corp.test",
        contact_email: "bo@corp.test", contact_name: "Bo Zhang", contact_external_id: "c1",
        flow_compiled_plan: { steps: [{ order: 1, template_ref: "welcome" }] },
      });
      const other = await b.newTenant();
      expect(await b.store.apiSentLog.getSentMessage({ tenantId: other, messageId: msgIds[1]! })).toBeNull();
      expect(await b.store.apiSentLog.getSentMessage({ tenantId, messageId: randomUUID() })).toBeNull();
    });

    it("listMessageEvents returns the message's events in time order with metadata", async () => {
      const s: any = b.schema;
      const evs = [
        { type: "clicked", at: now - 1 * H, metadata: { url: "https://x.test" } },
        { type: "delivered", at: now - 5 * H, metadata: null },
        { type: "opened", at: now - 3 * H, metadata: { ua: "Mail" } },
      ].map((e) => ({ id: randomUUID(), ...e }));
      await b.db.insert(s.messageEvents).values(
        evs.map((e) => ({
          id: e.id, tenantId, messageId: msgIds[1], eventType: e.type, occurredAt: new Date(e.at),
          metadata: e.metadata, createdAt: new Date(e.at + 1000),
        })),
      );
      await b.db.insert(s.messageEvents).values({
        id: randomUUID(), tenantId, messageId: msgIds[0], eventType: "opened", occurredAt: new Date(now),
      });
      const rows = await b.store.apiSentLog.listMessageEvents({ tenantId, messageId: msgIds[1]! });
      expect(rows.map((r) => norm(r, ["occurred_at", "created_at"]))).toEqual(
        [...evs]
          .sort((a, c) => a.at - c.at)
          .map((e) => ({ id: e.id, event_type: e.type, occurred_at: e.at, metadata: e.metadata, created_at: e.at + 1000 })),
      );
      const other = await b.newTenant();
      expect(await b.store.apiSentLog.listMessageEvents({ tenantId: other, messageId: msgIds[1]! })).toEqual([]);
    });
  });
}
