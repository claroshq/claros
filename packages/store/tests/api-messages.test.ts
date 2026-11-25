/**
 * Contract tests for the apiMessages store area (every backend).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

/** Insert contact, flow and membership for a tenant; returns their ids. */
async function seedMembership(b: Backend, tenantId: string, contact: Record<string, unknown> = {}) {
  const contactId = randomUUID();
  const flowId = randomUUID();
  const membershipId = randomUUID();
  await b.db.insert(b.schema.contacts).values({
    id: contactId,
    tenantId,
    externalId: `ext-${contactId.slice(0, 8)}`,
    lifecycleState: "signed_up",
    ...contact,
  });
  await b.db.insert(b.schema.flows).values({
    id: flowId,
    tenantId,
    name: "Flow",
    triggerType: "event",
    triggerConfig: {},
    steps: [],
  });
  await b.db.insert(b.schema.flowMemberships).values({
    id: membershipId,
    tenantId,
    contactId,
    flowId,
    enteredAt: new Date(),
  });
  return { contactId, flowId, membershipId };
}

let stepCounter = 0;

/** Insert a lifecycle message (new membership unless given); returns its id. */
async function seedMessage(
  b: Backend,
  tenantId: string,
  values: Record<string, unknown> = {},
  membership?: { contactId: string; flowId: string; membershipId: string },
) {
  const m = membership ?? (await seedMembership(b, tenantId));
  const id = (values.id as string | undefined) ?? randomUUID();
  await b.db.insert(b.schema.lifecycleMessages).values({
    id,
    tenantId,
    contactId: m.contactId,
    flowId: m.flowId,
    membershipId: m.membershipId,
    flowStepOrder: ++stepCounter,
    status: "pending_approval",
    ...values,
  });
  return id;
}

/**
 * Timestamps in list rows: node-postgres (as configured by Drizzle) returns raw
 * timestamptz text such as "2026-01-01 00:00:00.007+00", D1 returns Date.
 * Both are accepted by the caller (MessageListRow); compare as epoch ms.
 */
const asMs = (v: unknown): number | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const iso = String(v).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  return new Date(iso).getTime();
};
/** Cursor timestamp as the route builds it (Date -> ISO, string passed through). */
const cursorTs = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

for (const factory of testBackends()) {
  describe(`apiMessages on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("listMessages joins the contact, filters by status and pages by (created_at, id)", async () => {
      const t = await b.newTenant();
      const m = await seedMembership(b, t, { email: "a@example.com", name: "Ann" });
      const base = Date.UTC(2026, 0, 1, 0, 0, 0, 5);
      const scheduled = new Date(Date.UTC(2026, 0, 2));
      const ids: string[] = [];
      for (const [i, at] of [base + 2, base, base + 1, base + 1].entries()) {
        ids.push(
          await seedMessage(
            b,
            t,
            { createdAt: new Date(at), updatedAt: new Date(at), subject: `s${i}`, scheduledSendAt: i === 0 ? scheduled : null },
            m,
          ),
        );
      }
      await seedMessage(b, t, { status: "approved", createdAt: new Date(base) }, m);
      await seedMessage(b, await b.newTenant(), { createdAt: new Date(base) });

      const rows = await b.store.apiMessages.listMessages({ tenantId: t, status: "pending_approval", after: null, limit: 10 });
      expect(rows).toHaveLength(4);
      const tie = [ids[2]!, ids[3]!].sort();
      expect(rows.map((r) => r.id)).toEqual([ids[1], ...tie, ids[0]]);
      const first = rows[3]!;
      expect(first).toMatchObject({
        tenant_id: t,
        contact_id: m.contactId,
        flow_id: m.flowId,
        status: "pending_approval",
        subject: "s0",
        body_html: null,
        contact_email: "a@example.com",
        contact_name: "Ann",
      });
      expect(typeof first.flow_step_order).toBe("number");
      if (b.name === "d1") expect(first.created_at).toBeInstanceOf(Date);
      expect(asMs(first.created_at)).toBe(base + 2);
      expect(asMs(first.updated_at)).toBe(base + 2);
      expect(asMs(first.scheduled_send_at)).toBe(scheduled.getTime());
      expect(rows[0]!.scheduled_send_at).toBeNull();
      expect(rows[0]!.contact_external_id).toBe(`ext-${m.contactId.slice(0, 8)}`);

      const page2 = await b.store.apiMessages.listMessages({
        tenantId: t,
        status: "pending_approval",
        after: { createdAt: cursorTs(rows[1]!.created_at), id: rows[1]!.id },
        limit: 10,
      });
      expect(page2.map((r) => r.id)).toEqual(rows.slice(2).map((r) => r.id));
      const limited = await b.store.apiMessages.listMessages({ tenantId: t, status: "pending_approval", after: null, limit: 1 });
      expect(limited.map((r) => r.id)).toEqual([ids[1]]);
    });

    it("approveMessages / rejectMessages transition only pending_approval rows of the tenant", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const a = await seedMessage(b, t);
      const c = await seedMessage(b, t);
      const sent = await seedMessage(b, t, { status: "sent" });
      const foreign = await seedMessage(b, other);
      const now = new Date(Date.UTC(2026, 3, 1, 1, 2, 3, 4));
      const padding = Array.from({ length: 120 }, () => randomUUID());

      const approved = await b.store.apiMessages.approveMessages({ tenantId: t, ids: [a, sent, foreign, ...padding], now });
      expect(approved).toEqual([a]);
      expect(await b.store.apiMessages.getMessageStatus({ tenantId: t, messageId: a })).toBe("approved");
      expect(await b.store.apiMessages.getMessageStatus({ tenantId: t, messageId: sent })).toBe("sent");
      expect(await b.store.apiMessages.getMessageStatus({ tenantId: other, messageId: foreign })).toBe("pending_approval");
      const [row] = await b.store.apiMessages.listMessages({ tenantId: t, status: "approved", after: null, limit: 1 });
      expect(asMs(row!.updated_at)).toBe(now.getTime());

      const rejected = await b.store.apiMessages.rejectMessages({ tenantId: t, ids: [a, c], now });
      expect(rejected).toEqual([c]);
      expect(await b.store.apiMessages.getMessageStatus({ tenantId: t, messageId: c })).toBe("rejected");
    });

    it("approveMessage / rejectMessage are CAS on status: concurrent calls, exactly one wins", async () => {
      const t = await b.newTenant();
      const now = new Date();
      for (let round = 0; round < 3; round++) {
        const id = await seedMessage(b, t);
        const results = await Promise.all([
          b.store.apiMessages.approveMessage({ tenantId: t, messageId: id, now }),
          b.store.apiMessages.rejectMessage({ tenantId: t, messageId: id, now }),
          b.store.apiMessages.approveMessage({ tenantId: t, messageId: id, now }),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const status = await b.store.apiMessages.getMessageStatus({ tenantId: t, messageId: id });
        expect(status).toBe(results[1] ? "rejected" : "approved");
      }
      // bulk variants racing on the same ids: each id transitions once
      const ids = [await seedMessage(b, t), await seedMessage(b, t), await seedMessage(b, t)];
      const [x, y] = await Promise.all([
        b.store.apiMessages.approveMessages({ tenantId: t, ids, now }),
        b.store.apiMessages.rejectMessages({ tenantId: t, ids, now }),
      ]);
      expect([...x, ...y].sort()).toEqual([...ids].sort());
    });

    it("approveMessage sets approved_at; wrong tenant or status returns false", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, t);
      const now = new Date(Date.UTC(2026, 4, 1));
      expect(await b.store.apiMessages.approveMessage({ tenantId: await b.newTenant(), messageId: id, now })).toBe(false);
      expect(await b.store.apiMessages.approveMessage({ tenantId: t, messageId: id, now })).toBe(true);
      const [row] = await b.db
        .select({ approvedAt: b.schema.lifecycleMessages.approvedAt })
        .from(b.schema.lifecycleMessages)
        .where((await import("drizzle-orm")).eq(b.schema.lifecycleMessages.id, id));
      expect(row.approvedAt.getTime()).toBe(now.getTime());
      expect(await b.store.apiMessages.rejectMessage({ tenantId: t, messageId: id, now })).toBe(false);
    });

    it("requeueFailedGeneration only moves generation failures and resets retry_count", async () => {
      const t = await b.newTenant();
      const gen = await seedMessage(b, t, { status: "failed", brainReasoning: "generation_failed: timeout", retryCount: 3 });
      const send = await seedMessage(b, t, { status: "failed", brainReasoning: "send_failed: 500" });
      const now = new Date();
      const results = await Promise.all([
        b.store.apiMessages.requeueFailedGeneration({ tenantId: t, messageId: gen, now }),
        b.store.apiMessages.requeueFailedGeneration({ tenantId: t, messageId: gen, now }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await b.store.apiMessages.requeueFailedGeneration({ tenantId: t, messageId: send, now })).toBe(false);
      expect(await b.store.apiMessages.getMessageStatus({ tenantId: t, messageId: gen })).toBe("pending_generation");
      const { eq } = await import("drizzle-orm");
      const [row] = await b.db
        .select({ retryCount: b.schema.lifecycleMessages.retryCount })
        .from(b.schema.lifecycleMessages)
        .where(eq(b.schema.lifecycleMessages.id, gen));
      expect(row.retryCount).toBe(0);
    });

    it("getMessageStatus returns null for unknown or foreign messages", async () => {
      const t = await b.newTenant();
      const id = await seedMessage(b, t, { status: "sent" });
      expect(await b.store.apiMessages.getMessageStatus({ tenantId: t, messageId: id })).toBe("sent");
      expect(await b.store.apiMessages.getMessageStatus({ tenantId: await b.newTenant(), messageId: id })).toBeNull();
      expect(await b.store.apiMessages.getMessageStatus({ tenantId: t, messageId: randomUUID() })).toBeNull();
    });
  });
}
