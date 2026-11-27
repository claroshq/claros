/**
 * Contract tests (every backend) for the approval actions (G20) and the
 * approval outbox events (G14): actors, edit with originals, regenerate
 * with a forced action, cancel, unapprove, critical-first listing, and
 * outbox rows written only for transitions that happened.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";
import { insertContact, insertFlow, insertMembership, insertMessage } from "./support/worker-fixtures.js";
import { insertEndpoint, outboxOf } from "./support/outbox-fixtures.js";

const NOW = new Date("2026-11-20T10:00:00Z");

for (const factory of testBackends()) {
  describe(`approval actions on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    async function seed(t: string, status = "pending_approval", flowValues: Record<string, unknown> = {}, createdAt = NOW) {
      const c = await insertContact(b, t);
      const f = await insertFlow(b, t, flowValues);
      const m = await insertMembership(b, { tenantId: t, contactId: c, flowId: f });
      return insertMessage(b, {
        tenantId: t, contactId: c, flowId: f, membershipId: m, flowStepOrder: 1, status,
        subject: "Drafted", bodyHtml: "<p>Drafted</p>", bodyText: "Drafted", brainActionType: "welcome", createdAt,
      });
    }
    const row = async (id: string) => (await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, id)))[0];

    it("approve/reject record the actor and write approval events only for transitioned ids", async () => {
      const t = await b.newTenant();
      await insertEndpoint(b, t, ["message.approved", "message.rejected"]);
      const a1 = await seed(t);
      const a2 = await seed(t);
      const done = await seed(t, "sent");
      const approved = await b.store.apiMessages.approveMessages({ tenantId: t, ids: [a1, a2, done], now: NOW, actor: "user:u1" });
      expect([...approved].sort()).toEqual([a1, a2].sort());
      expect((await row(a1)).approvedBy).toBe("user:u1");
      const r1 = await seed(t);
      expect(await b.store.apiMessages.rejectMessage({ tenantId: t, messageId: r1, now: NOW, actor: "api_key:k1" })).toBe(true);
      expect(await b.store.apiMessages.rejectMessage({ tenantId: t, messageId: r1, now: NOW, actor: "api_key:k1" })).toBe(false);
      expect((await row(r1)).rejectedBy).toBe("api_key:k1");
      const events = await outboxOf(b, t);
      expect(events.map((e) => `${e.event}:${e.payload.message_id}`).sort()).toEqual(
        [`message.approved:${a1}`, `message.approved:${a2}`, `message.rejected:${r1}`].sort(),
      );
    });

    it("concurrent approvals of one message: one wins, one event", async () => {
      const t = await b.newTenant();
      await insertEndpoint(b, t, ["message.approved"]);
      const id = await seed(t);
      const results = await Promise.all([
        b.store.apiMessages.approveMessage({ tenantId: t, messageId: id, now: NOW, actor: "user:a" }),
        b.store.apiMessages.approveMessage({ tenantId: t, messageId: id, now: NOW, actor: "user:b" }),
      ]);
      expect(results.filter(Boolean).length).toBe(1);
      expect((await outboxOf(b, t)).length).toBe(1);
    });

    it("editMessage keeps the drafted content from the first edit; refused unless pending_approval", async () => {
      const t = await b.newTenant();
      const id = await seed(t);
      const edit = (subject: string) =>
        b.store.apiMessages.editMessage({ tenantId: t, messageId: id, subject, bodyHtml: `<p>${subject}</p>`, bodyText: subject, actor: "user:e", now: NOW });
      expect(await edit("First edit")).toBe(true);
      expect(await edit("Second edit")).toBe(true);
      const r = await row(id);
      expect(r).toMatchObject({
        subject: "Second edit", bodyText: "Second edit", originalSubject: "Drafted", originalBodyHtml: "<p>Drafted</p>",
        originalBodyText: "Drafted", editedBy: "user:e", status: "pending_approval",
      });
      expect(r.editedAt).toEqual(NOW);
      expect(await b.store.apiMessages.getMessageContent({ tenantId: t, messageId: id })).toEqual({
        status: "pending_approval", subject: "Second edit", bodyHtml: "<p>Second edit</p>", bodyText: "Second edit",
      });
      const sent = await seed(t, "approved");
      expect(await b.store.apiMessages.editMessage({ tenantId: t, messageId: sent, subject: "x", bodyHtml: "x", bodyText: "x", actor: "user:e", now: NOW })).toBe(false);
      expect((await row(sent)).subject).toBe("Drafted");
      expect(await b.store.apiMessages.getMessageContent({ tenantId: await b.newTenant(), messageId: id })).toBeNull();
    });

    it("regenerateMessage sends back to generation with a forced action and clears edit markers", async () => {
      const t = await b.newTenant();
      const id = await seed(t);
      await b.store.apiMessages.editMessage({ tenantId: t, messageId: id, subject: "E", bodyHtml: "E", bodyText: "E", actor: "user:e", now: NOW });
      expect(await b.store.apiMessages.regenerateMessage({ tenantId: t, messageId: id, actionType: "tip_trick", now: NOW })).toBe(true);
      expect(await row(id)).toMatchObject({
        status: "pending_generation", brainActionType: "tip_trick", forcedActionType: "tip_trick", retryCount: 0,
        editedBy: null, editedAt: null, originalSubject: null,
      });
      expect(await b.store.apiMessages.regenerateMessage({ tenantId: t, messageId: id, actionType: null, now: NOW })).toBe(false);
      const plain = await seed(t);
      expect(await b.store.apiMessages.regenerateMessage({ tenantId: t, messageId: plain, actionType: null, now: NOW })).toBe(true);
      expect(await row(plain)).toMatchObject({ status: "pending_generation", brainActionType: "welcome", forcedActionType: null });
    });

    it("regenerateMessage with a revision keeps the draft and the action, appends the thread; the worker sees it and completeDraft clears it", async () => {
      const t = await b.newTenant();
      const id = await seed(t);
      const first = { instruction: "There is no /mcp page.", by: "user:r", at: NOW.toISOString() };
      expect(await b.store.apiMessages.regenerateMessage({ tenantId: t, messageId: id, actionType: null, revision: first, now: NOW })).toBe(true);
      expect(await row(id)).toMatchObject({
        status: "pending_generation", subject: "Drafted", bodyText: "Drafted", brainActionType: "welcome",
        revisionRequest: "There is no /mcp page.",
      });
      const [claimed] = await b.store.workerContent.claimContentBatch({ now: NOW, limit: 10, tenantIds: [t] });
      expect(claimed).toMatchObject({ id, revisionRequest: "There is no /mcp page.", previousSubject: "Drafted", previousBodyText: "Drafted" });
      expect(await b.store.workerContent.markAwaitingContent(id, "revised", NOW)).toBe(true);
      expect(await b.store.workerContent.completeDraft(id, "pending_approval", { subject: "Revised", bodyHtml: "<p>Revised</p>", bodyText: "Revised" }, null, NOW)).toBe(true);
      expect(await row(id)).toMatchObject({ status: "pending_approval", subject: "Revised", revisionRequest: null });

      const second = { instruction: "Shorter.", by: "api_key:k", at: NOW.toISOString() };
      expect(await b.store.apiMessages.regenerateMessage({ tenantId: t, messageId: id, actionType: null, revision: second, now: NOW })).toBe(true);
      const listed = await b.store.apiMessages.getMessage({ tenantId: t, messageId: id });
      expect(listed?.revisions).toEqual([first, second]);
      expect(listed?.revision_request).toBe("Shorter.");
    });

    it("cancel moves approved to cancelled; unapprove moves approved back with a batched pending_approval event", async () => {
      const t = await b.newTenant();
      const ep = await insertEndpoint(b, t, ["message.pending_approval"]);
      const c1 = await seed(t, "approved");
      expect(await b.store.apiMessages.cancelMessage({ tenantId: t, messageId: c1, actor: "user:c", now: NOW })).toBe(true);
      expect(await row(c1)).toMatchObject({ status: "cancelled", statusReason: "cancelled", rejectedBy: "user:c" });
      expect(await b.store.apiMessages.cancelMessage({ tenantId: t, messageId: c1, actor: "user:c", now: NOW })).toBe(false);

      const u1 = await seed(t, "approved");
      const u2 = await seed(t, "approved");
      const entry = (id: string) => [{ event: "message.pending_approval", payload: { message_id: id }, dedupKey: "message.pending_approval:1", deliverAt: NOW }];
      expect(await b.store.apiMessages.unapproveMessage({ tenantId: t, messageId: u1, now: NOW, outbox: entry(u1) })).toBe(true);
      expect(await b.store.apiMessages.unapproveMessage({ tenantId: t, messageId: u2, now: NOW, outbox: entry(u2) })).toBe(true);
      expect(await b.store.apiMessages.unapproveMessage({ tenantId: t, messageId: u2, now: NOW, outbox: entry(u2) })).toBe(false);
      expect(await row(u1)).toMatchObject({ status: "pending_approval", approvedAt: null, approvedBy: null });
      // One ping per window: the second message's entry has the same dedup key.
      expect(await outboxOf(b, t)).toEqual([
        { event: "message.pending_approval", payload: { message_id: u1 }, endpointId: ep, dedupKey: "message.pending_approval:1" },
      ]);
    });

    it("listMessages puts critical flows first and pages with the rank in the cursor", async () => {
      const t = await b.newTenant();
      const n1 = await seed(t, "pending_approval", {}, new Date("2026-11-01T00:00:00Z"));
      const c1 = await seed(t, "pending_approval", { flowClass: "critical", name: "Dunning" }, new Date("2026-11-05T00:00:00Z"));
      const n2 = await seed(t, "pending_approval", {}, new Date("2026-11-02T00:00:00Z"));
      const all = await b.store.apiMessages.listMessages({ tenantId: t, status: "pending_approval", after: null, limit: 10 });
      expect(all.map((r) => r.id)).toEqual([c1, n1, n2]);
      expect(all[0]).toMatchObject({ flow_class: "critical", flow_name: "Dunning", approved_by: null, edited_at: null });
      const page2 = await b.store.apiMessages.listMessages({
        tenantId: t, status: "pending_approval", limit: 10,
        after: { createdAt: new Date(all[0]!.created_at as Date).toISOString(), id: c1, rank: 0 },
      });
      expect(page2.map((r) => r.id)).toEqual([n1, n2]);
      const page3 = await b.store.apiMessages.listMessages({
        tenantId: t, status: "pending_approval", limit: 10,
        after: { createdAt: new Date(all[1]!.created_at as Date).toISOString(), id: n1 },
      });
      expect(page3.map((r) => r.id)).toEqual([n2]);
    });

    it("completeDraft to pending_approval writes the batched event; to approved writes none", async () => {
      const t = await b.newTenant();
      await insertEndpoint(b, t, ["message.pending_approval"]);
      const p1 = await seed(t, "awaiting_content");
      const ev = { tenantId: t, outbox: [{ event: "message.pending_approval", payload: { message_id: p1 }, dedupKey: "k", deliverAt: NOW }] };
      expect(await b.store.workerContent.completeDraft(p1, "pending_approval", { subject: "s", bodyHtml: "h", bodyText: "t" }, null, NOW, ev)).toBe(true);
      expect(await b.store.workerContent.completeDraft(p1, "pending_approval", { subject: "s", bodyHtml: "h", bodyText: "t" }, null, NOW, ev)).toBe(false);
      const p2 = await seed(t, "generating");
      expect(await b.store.workerContent.completeTemplate(p2, "approved", { subject: "s", bodyHtml: "h", bodyText: "t" }, NOW, "template_rendered: x", NOW)).toBe(true);
      expect((await outboxOf(b, t)).map((e) => e.payload.message_id)).toEqual([p1]);
    });
  });
}
