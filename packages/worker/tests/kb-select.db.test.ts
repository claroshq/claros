/**
 * G18 kb_select in the content pipeline on Postgres (when DATABASE_URL is
 * set) and D1: exclude_used never repeats an entry, imported history
 * included; tags_any_from_trait; an exhausted category skips the message.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { storeFor } from "@claros/store";
import { processContentTick } from "../src/content.js";
import { filterByTraitTags, pickKbEntry } from "../src/kb-select.js";
import { engineBackends, type EngineBackend } from "./support/engine-backends.js";

describe("kb-select helpers", () => {
  const e = (id: string, tags: string[] | null, title = id) => ({ id, title, content: "", tags, createdAt: null });
  it("filters by trait tags and keeps untagged entries", () => {
    const rows = [e("a", ["pro"]), e("b", ["free"]), e("c", null)];
    expect(filterByTraitTags(rows, "pro").map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterByTraitTags(rows, ["free", "x"]).map((r) => r.id)).toEqual(["b", "c"]);
    expect(filterByTraitTags(rows, undefined).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("picks oldest or best match", () => {
    const rows = [e("a", null, "Saved searches"), e("b", null, "Export contacts to CSV")];
    expect(pickKbEntry(rows, undefined, "csv export")!.id).toBe("a");
    expect(pickKbEntry(rows, "best_match", "csv export of contacts")!.id).toBe("b");
  });
});

for (const factory of engineBackends()) {
  describe(`kb_select (${factory.name})`, () => {
    let b: EngineBackend;
    beforeAll(async () => {
      b = await factory.open();
    });
    afterAll(async () => {
      await b.close();
    });

    it("never sends an entry twice to a contact, imported history included", async () => {
      const tenantId = await b.newTenant();
      await storeFor(b.db).apiKb.importEntries({
        tenantId,
        entries: ["k1", "k2", "k3"].map((k, i) => ({
          externalKey: k, title: `Tip ${k}`, content: `Body ${k}`, contentType: "markdown", category: "tip_trick",
          tags: i === 2 ? ["business"] : null, data: null, pinned: false, isActive: true, sourceUrl: null,
        })),
        force: false, dryRun: false, markPending: false, now: new Date(Date.now() - 60_000),
      });
      const k1 = (await storeFor(b.db).apiKb.findEntryByExternalKey({ tenantId, externalKey: "k1" }))!;
      await b.db.insert(b.schema.templates).values({ tenantId, slug: "tip", name: "Tip", subject: "{{kb.title}}", bodyHtml: "<p>{{kb.content}}</p>", isActive: true });
      const flowId = randomUUID();
      const steps = [{ order: 1, action_type: "tip_trick", delay: "0m", template_ref: "tip", kb_select: { category: "tip_trick", tags_any_from_trait: "plan_tier" } }];
      await b.db.insert(b.schema.flows).values({
        id: flowId, tenantId, name: "Tips", triggerType: "event", triggerConfig: { event: "x" }, steps, status: "active",
        compileStatus: "ready", compiledPlan: { trigger: { type: "event", condition: { event: "x" } }, steps }, approvalMode: "auto",
      });
      const contactId = randomUUID();
      await b.db.insert(b.schema.contacts).values({ id: contactId, tenantId, externalId: "u", email: "u@example.com", lifecycleState: "engaged", properties: { plan_tier: "pro" } });
      // Imported history: k1 went out before the move to Claros.
      const hist = randomUUID();
      await b.db.insert(b.schema.flowMemberships).values({ id: hist, tenantId, contactId, flowId, enteredAt: new Date(0), status: "completed" });
      await b.db.insert(b.schema.lifecycleMessages).values({ tenantId, contactId, flowId, membershipId: hist, flowStepOrder: 1, status: "sent", imported: true, kbEntryId: k1.id, sentAt: new Date(0) });

      const sendOne = async () => {
        const membershipId = randomUUID();
        await b.db.insert(b.schema.flowMemberships).values({ id: membershipId, tenantId, contactId, flowId, enteredAt: new Date(), status: "completed" });
        const id = randomUUID();
        await b.db.insert(b.schema.lifecycleMessages).values({ id, tenantId, contactId, flowId, membershipId, flowStepOrder: 1, status: "pending_generation", brainActionType: "tip_trick" });
        await processContentTick(b.db, new Date(), 20, [tenantId]);
        return (await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, id)))[0];
      };
      const first = await sendOne();
      expect(first.status).toBe("approved");
      expect(first.subject).toBe("Tip k2");
      // k3 is tagged for business only (plan_tier pro): nothing left.
      const second = await sendOne();
      expect(second.status).toBe("skipped");
      expect(second.brainReasoning).toContain("kb_exhausted");
    });
  });
}
