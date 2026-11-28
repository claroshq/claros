/**
 * Scenario: the first product's configuration (tests/fixtures/product-config.json,
 * product-neutral names) written with the P5b features instead of its old
 * workarounds: a date_schedule nudge in the scheduled class, a nurture
 * choose flow on a lifecycle segment with a NOT exclusion, a trial_ending
 * date_property flow on the transactional topic, dunning with merged
 * founding-price sections, persona, eyebrow and preheader per step, a
 * mirror-only topic, LLM budget, approvals digest and batching settings.
 *
 * It validates with zero errors and zero warnings, applies on each backend
 * (Postgres when DATABASE_URL is set, and D1), applies again as an empty
 * diff, and an engine run with a fake LLM, a fake data source and fake
 * transports enrolls and sends: the scheduled nudge alongside the nurture
 * choose flow for the same contact, trial_ending through the cloudflare
 * (transactional) transport, and dunning.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { storeFor } from "@claros/store";
import { clarosConfigSchema, planConfig, type ConfigOp } from "@claros/core";
import { decrypt, encrypt, parseEncryptionKey } from "@claros/adapters";
import { phaseSegmentEnrollment } from "../src/scan-segment-enrollment.js";
import { phaseDateEnrollment } from "../src/date-flows.js";
import { phaseStepAdvancement } from "../src/scan-step-advancement.js";
import { handleTriggerCheck } from "../src/trigger-check.js";
import { processContentTick } from "../src/content.js";
import { processDrainTick, fetchDrainBatchSimple, type FetchDrainBatch } from "../src/drain.js";
import { engineBackends, type EngineBackend } from "./support/engine-backends.js";
import { startFakeLlm, useFakeLlm, DEFAULT_ANSWERS, TEST_ENCRYPTION_KEY, type FakeLlm } from "./support/fake-llm.js";
import { fakeTransports } from "./support/fake-transport.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/product-config.json", import.meta.url), "utf8")) as Record<string, any>;
const SIGNING_KEY = "b".repeat(64);
const NOW = new Date("2026-12-01T10:00:00Z"); // a Tuesday, inside the send window
const HOUR = 3_600_000;

/** A fake product data source: answers the leads context with two leads, records the requests. */
async function startDataSource(): Promise<{ url: string; requests: Array<{ body: any; signed: boolean }>; close(): Promise<void> }> {
  const requests: Array<{ body: any; signed: boolean }> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({ body: JSON.parse(raw), signed: typeof req.headers["webhook-signature"] === "string" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { leads: [{ name: "Northwind", url: "https://northwind.example/" }, { name: "Globex", url: "https://globex.example/" }] }, empty: false }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("product config fixture", () => {
  it("validates with zero errors and zero warnings", () => {
    const parsed = clarosConfigSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    const state = {
      settings: {}, locale: null, configVersion: 0, topics: [], templates: [], flows: [], endpoints: [], hasLlm: true,
      transports: [
        { id: "t1", name: "cloudflare-send", kind: "cloudflare", isActive: true },
        { id: "t2", name: "resend-main", kind: "resend", isActive: true },
      ],
    };
    const plan = planConfig(parsed.success ? parsed.data : (null as never), state, { newId: () => randomUUID(), newSecret: () => "whsec_x", readSecret: () => null });
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("uses no documented workaround", () => {
    const text = JSON.stringify(fixture);
    expect(fixture.templates.some((t: any) => t.slug.endsWith("_founding"))).toBe(false);
    expect(fixture.flows.some((f: any) => f.slug === "plan_changed_downgrade")).toBe(false);
    expect(text).not.toContain('display:none;max-height:0');
    const nurture = fixture.flows.find((f: any) => f.slug === "nurture");
    expect(nurture.status).toBe("active");
    expect(nurture.steps[0].type).toBe("choose");
    expect(fixture.flows.find((f: any) => f.slug === "icp_setup_nudge").trigger.type).toBe("date_schedule");
    expect(fixture.flows.find((f: any) => f.slug === "trial_ending").trigger.type).toBe("date_property");
    expect(fixture.topics.find((t: any) => t.slug === "weekly_digest").mirror_only).toBe(true);
  });
});

for (const factory of engineBackends()) {
  describe(`product scenario (${factory.name})`, () => {
    let b: EngineBackend;
    let llm: FakeLlm;
    let ds: Awaited<ReturnType<typeof startDataSource>>;
    beforeAll(async () => {
      b = await factory.open();
      llm = await startFakeLlm();
      ds = await startDataSource();
      process.env.ENCRYPTION_KEY ??= TEST_ENCRYPTION_KEY;
      process.env.CLAROS_CONTEXT_SECRET = "context-secret-for-the-scenario-test";
    });
    afterAll(async () => {
      await ds.close();
      await llm.close();
      await b.close();
    });

    it("applies, then enrolls and sends through the scheduled nudge, nurture choose, trial_ending and dunning", async () => {
      const t = await b.newTenant();
      await b.db.insert(b.schema.transportConfigs).values([
        { tenantId: t, provider: "cloudflare", kind: "cloudflare", name: "cloudflare-send", config: {}, fromEmail: "hello@send.acme-leads.example", isActive: true },
        { tenantId: t, provider: "resend", kind: "resend", name: "resend-main", config: {}, fromEmail: "hello@mail.acme-leads.example", isActive: true },
      ]);
      await useFakeLlm(b, t, llm);

      // --- Apply (the same planning and secret handling PUT /v1/config runs).
      const doc = JSON.parse(JSON.stringify(fixture));
      doc.settings.data_sources.leads.url = `${ds.url}/internal/claros/context/leads`;
      const config = clarosConfigSchema.parse(doc);
      const key = parseEncryptionKey(process.env.ENCRYPTION_KEY!);
      const store = storeFor(b.db).apiConfig;
      const state = (await store.loadConfigState(t))!;
      const plan = planConfig(config, state, { newId: () => randomUUID(), newSecret: () => "whsec_unused", readSecret: () => null });
      expect(plan.errors).toEqual([]);
      expect(plan.warnings).toEqual([]);
      const ops: ConfigOp[] = plan.ops.map((op) => (op.op === "upsertEndpoint" && op.secret !== undefined ? { ...op, secret: encrypt(op.secret, key) } : op));
      const applied = await store.applyConfigOps({ tenantId: t, ops, expectedVersion: state.configVersion, now: NOW });
      expect(applied.ok).toBe(true);
      const again = planConfig(config, (await store.loadConfigState(t))!, {
        newId: () => randomUUID(),
        newSecret: () => "whsec_unused",
        readSecret: (enc) => {
          try {
            return decrypt(enc, key);
          } catch {
            return null;
          }
        },
      });
      expect(again.errors).toEqual([]);
      expect(again.changes).toEqual([]);

      const flows = await b.db.select().from(b.schema.flows).where(eq(b.schema.flows.tenantId, t));
      const flowId = (slug: string) => flows.find((f: any) => f.slug === slug)!.id as string;
      expect(flows.find((f: any) => f.slug === "icp_setup_nudge").flowClass).toBe("scheduled");
      const topics = await b.db.select().from(b.schema.topics).where(eq(b.schema.topics.tenantId, t));
      expect(topics.find((x: any) => x.slug === "weekly_digest").mirrorOnly).toBe(true);

      // --- Knowledge base and contacts.
      for (const category of ["tip_trick", "feature_edu", "onboarding_rescue"]) {
        await b.db.insert(b.schema.kbEntries).values({ tenantId: t, title: `${category} one`, content: `About ${category}.`, category, isActive: true });
      }
      const contact = async (externalId: string, state: string, props: Record<string, unknown>) => {
        const id = randomUUID();
        // payment_status is a reserved trait: ingest stores it in its column, never in properties.
        const { payment_status: paymentStatus, ...rest } = props as { payment_status?: string };
        await b.db.insert(b.schema.contacts).values({
          id, tenantId: t, externalId, email: `${externalId}@example.com`, lifecycleState: state, paymentStatus: paymentStatus ?? "free", properties: { timezone: "UTC", first_name: externalId, ...rest },
          firstSeenAt: new Date(NOW.getTime() - 40 * 24 * HOUR), lastSeenAt: new Date(NOW.getTime() - 2 * HOUR),
        });
        await storeFor(b.db).apiIngest.syncContactDates({ tenantId: t, externalId, changedKeys: Object.keys(rest), now: NOW });
        return id;
      };
      // Paid, no ICP yet: the scheduled ICP nudge (slot 1d at 09:30) and the nurture segment.
      const paid = await contact("paid", "engaged", { plan_tier: "pro", payment_status: "paid", icp_configured: false, first_paid_at: "2026-11-30T08:00:00Z" });
      // On trial: trial_ending at 09:00 three days before trial_ends_at.
      const trial = await contact("trial", "signed_up", { plan_tier: "pro", payment_status: "trial", trial_ends_at: "2026-12-04T08:00:00Z" });
      // Past due with a founding price: dunning.
      const pastDue = await contact("pastdue", "signed_up", { plan_tier: "pro", payment_status: "past_due", founding_price: true });

      // --- Enroll.
      await phaseSegmentEnrollment(b.db, NOW, [t]);
      await phaseDateEnrollment(b.db, NOW, [t]);
      await handleTriggerCheck({ tenant_id: t, contact_id: pastDue, event_name: "payment_failed", event_properties: { amount: 49 } }, b.db);
      const active = await b.db.select().from(b.schema.flowMemberships).where(and(eq(b.schema.flowMemberships.tenantId, t), eq(b.schema.flowMemberships.status, "active")));
      const by = (contactId: string) => active.filter((m: any) => m.contactId === contactId).map((m: any) => m.flowId).sort();
      // The scheduled nudge runs alongside the nurture flow for the same contact.
      expect(by(paid)).toEqual([flowId("icp_setup_nudge"), flowId("nurture")].sort());
      expect(by(trial)).toEqual([flowId("trial_ending")]);
      expect(by(pastDue)).toEqual([flowId("dunning")]);

      // --- Messages and content (fake LLM, fake data source).
      await phaseStepAdvancement(b.db, NOW, [t]);
      llm.answer = (c) => {
        if (c.kind === "choose") return { choice: "tip_trick", reason: "a tip fits an engaged pro user" };
        if (c.kind === "draft") {
          return c.user.includes("icp_setup_nudge")
            ? { subject: "Set your ICP once", body_markdown: "Hi, set it up here: [your ICP](https://acme-leads.example/dashboard/icp)\n\nSam" }
            : { subject: "A quick tip", body_markdown: "Hi, one thing that helps: open your [dashboard](https://acme-leads.example/dashboard) each morning.\n\nSam" };
        }
        return DEFAULT_ANSWERS[c.kind];
      };
      await processContentTick(b.db, NOW, 50, [t]);
      const msgs = await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.tenantId, t));
      const msg = (slug: string) => msgs.find((m: any) => m.flowId === flowId(slug))!;
      expect(msg("trial_ending").status).toBe("approved");
      expect(msg("dunning").status).toBe("approved");
      expect(msg("dunning").bodyHtml).toContain("founding price");
      expect(msg("icp_setup_nudge").status).toBe("pending_approval");
      expect(msg("icp_setup_nudge").contextSnapshot).toMatchObject({ leads: { leads: [{ name: "Northwind" }, { name: "Globex" }] } });
      expect(msg("nurture").status).toBe("pending_approval");
      expect(msg("nurture").brainActionType).toBe("tip_trick");
      expect(ds.requests.some((r) => r.signed && r.body.source === "leads" && r.body.mode === "inferred")).toBe(true);

      // Approve the two drafts (what a reviewer does).
      for (const slug of ["icp_setup_nudge", "nurture"]) {
        await b.db.update(b.schema.lifecycleMessages).set({ status: "approved", approvedAt: NOW }).where(eq(b.schema.lifecycleMessages.id, msg(slug).id));
      }

      // --- Send (fake transports: transactional -> cloudflare, default -> resend).
      const fake = fakeTransports();
      const scoped: FetchDrainBatch = (d, n, limit, ids) => fetchDrainBatchSimple(d, n, limit, ids.filter((x) => x === t));
      const drain = (at: Date) => processDrainTick(b.db, at, fake.resolver([t]), scoped, 50, "http://localhost:3000", SIGNING_KEY, false);
      await drain(NOW);
      // The paid contact gets one mail a day (throttle): the other waits for tomorrow.
      await drain(new Date(NOW.getTime() + 25 * HOUR));
      const to = (ext: string) => fake.sent.filter((m) => m.to === `${ext}@example.com`);

      const trialMail = to("trial");
      expect(trialMail).toHaveLength(1);
      expect(trialMail[0]!.transport).toBe("cloudflare");
      expect(trialMail[0]!.headers?.["List-Unsubscribe"]).toBeUndefined();
      expect(trialMail[0]!.fromName).toBe("The Acme Leads team");

      const dunningMail = to("pastdue");
      expect(dunningMail).toHaveLength(1);
      expect(dunningMail[0]!.transport).toBe("cloudflare");
      expect(dunningMail[0]!.bodyHtml).toContain("PAYMENT ISSUE");

      const paidMail = to("paid");
      expect(paidMail).toHaveLength(2);
      expect(paidMail.every((m) => m.transport === "resend")).toBe(true);
      expect(paidMail.every((m) => typeof m.headers?.["List-Unsubscribe"] === "string")).toBe(true);
      expect(paidMail.map((m) => m.subject).sort()).toEqual(["A quick tip", "Set your ICP once"]);
      expect(paidMail.every((m) => m.fromName === "Sam from Acme Leads")).toBe(true);
      expect(paidMail.find((m) => m.subject === "Set your ICP once")!.bodyHtml).toContain("SET IT ONCE");
      expect(paidMail.find((m) => m.subject === "A quick tip")!.bodyHtml).toContain("QUICK TIP");
    });
  });
}
