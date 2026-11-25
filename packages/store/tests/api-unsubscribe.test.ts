/**
 * Contract tests for the apiUnsubscribe store area (every backend).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
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

for (const factory of testBackends()) {
  describe(`apiUnsubscribe on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    it("findTenantIdByPublicHost maps a product public host to its id", async () => {
      const t = await b.newTenant();
      const host = `news-${randomUUID().slice(0, 8)}.example.com`;
      expect(await b.store.apiUnsubscribe.findTenantIdByPublicHost(host)).toBeNull();
      await b.db.update(b.schema.tenants).set({ publicHost: host }).where(eq(b.schema.tenants.id, t));
      expect(await b.store.apiUnsubscribe.findTenantIdByPublicHost(host)).toBe(t);
      expect(await b.store.apiUnsubscribe.findTenantIdByPublicHost(`other-${host}`)).toBeNull();
    });

    it("getMessageRecipient returns address and status, tenant scoped", async () => {
      const t = await b.newTenant();
      const sent = await seedMessage(b, t, { status: "sent", recipientAddress: "ann@example.com" });
      const pending = await seedMessage(b, t, { status: "approved" });
      expect(await b.store.apiUnsubscribe.getMessageRecipient({ tenantId: t, messageId: sent })).toEqual({
        recipientAddress: "ann@example.com",
        status: "sent",
      });
      expect(await b.store.apiUnsubscribe.getMessageRecipient({ tenantId: t, messageId: pending })).toEqual({
        recipientAddress: null,
        status: "approved",
      });
      expect(await b.store.apiUnsubscribe.getMessageRecipient({ tenantId: await b.newTenant(), messageId: sent })).toBeNull();
      expect(await b.store.apiUnsubscribe.getMessageRecipient({ tenantId: t, messageId: randomUUID() })).toBeNull();
    });

    it("suppressAddress is idempotent case-insensitively, also under concurrency", async () => {
      const t = await b.newTenant();
      await Promise.all(
        ["Ann@example.com", "ann@example.com", "ANN@EXAMPLE.COM"].map((email) =>
          b.store.apiUnsubscribe.suppressAddress({ tenantId: t, email, reason: "unsubscribe", source: "one_click" }),
        ),
      );
      await b.store.apiUnsubscribe.suppressAddress({ tenantId: t, email: "ann@example.com", reason: "unsubscribe", source: "page" });
      const rows = await b.db.select().from(b.schema.suppressions).where(eq(b.schema.suppressions.tenantId, t));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ reason: "unsubscribe", source: "one_click" });
      expect(rows[0].createdAt).toBeInstanceOf(Date);
      await b.store.apiUnsubscribe.suppressAddress({ tenantId: await b.newTenant(), email: "ann@example.com", reason: "unsubscribe", source: "page" });
      expect(await b.db.select().from(b.schema.suppressions).where(eq(b.schema.suppressions.tenantId, t))).toHaveLength(1);
    });
  });
}
