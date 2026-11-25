/**
 * G11 context-fetch hook on Postgres (when DATABASE_URL is set) and D1: a
 * local HTTP server plays the product's data source. Signed request body,
 * snapshot on the message, Mustache sections in a fixed template, on_empty
 * and on_error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { verifyWebhook } from "@claros/core";
import { processContentTick } from "../src/content.js";
import { engineBackends, type EngineBackend } from "./support/engine-backends.js";

const SECRET = "whsec_context_test_secret_123456";
process.env.CLAROS_TEST_CONTEXT_SECRET = SECRET;

interface Seen {
  body: any;
  verified: boolean;
}
let server: Server;
let base = "";
const seen: Seen[] = [];
let reply: (body: any) => { status: number; json?: unknown; delayMs?: number } = () => ({ status: 200, json: { data: {}, empty: true } });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
      const body = JSON.parse(raw);
      seen.push({ body, verified: verifyWebhook({ headers, body: raw, secret: SECRET }) });
      const r = reply(body);
      setTimeout(() => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json ?? {}));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

for (const factory of engineBackends()) {
  describe(`context-fetch hook (${factory.name})`, () => {
    let b: EngineBackend;
    beforeAll(async () => {
      b = await factory.open();
    });
    afterAll(async () => {
      await b.close();
    });

    async function setup(step: Record<string, unknown>, timeoutMs = 2000) {
      const tenantId = await b.newTenant({
        data_sources: { leads: { url: `${base}/context/leads`, secret_ref: "CLAROS_TEST_CONTEXT_SECRET", timeout_ms: timeoutMs } },
      });
      await b.db.insert(b.schema.templates).values({
        tenantId,
        slug: "leads",
        name: "Leads",
        subject: "Leads for {{contact.first_name|you}}",
        bodyHtml: "<ul>{{#context.leads.leads}}<li><a href=\"{{url}}\">{{name}}</a></li>{{/context.leads.leads}}</ul>{{^context.leads.leads}}<p>none</p>{{/context.leads.leads}}",
        isActive: true,
      });
      const flowId = randomUUID();
      const steps = [{ order: 1, action_type: "curated_leads", delay: "0m", template_ref: "leads", ...step }];
      await b.db.insert(b.schema.flows).values({
        id: flowId,
        tenantId,
        slug: "icp_setup_nudge",
        name: "ICP nudge",
        triggerType: "event",
        triggerConfig: { event: "x" },
        steps,
        status: "active",
        compileStatus: "ready",
        compiledPlan: { trigger: { type: "event", condition: { event: "x" } }, steps },
        approvalMode: "require",
        contentMode: "fixed_content",
      });
      const contactId = randomUUID();
      await b.db.insert(b.schema.contacts).values({
        id: contactId, tenantId, externalId: "user-1", email: "u1@example.com", lifecycleState: "activated", properties: { plan_tier: "pro" },
      });
      const membershipId = randomUUID();
      await b.db.insert(b.schema.flowMemberships).values({ id: membershipId, tenantId, contactId, flowId, enteredAt: new Date(), status: "active" });
      const messageId = randomUUID();
      await b.db.insert(b.schema.lifecycleMessages).values({
        id: messageId, tenantId, contactId, flowId, membershipId, flowStepOrder: 1, status: "pending_generation", brainActionType: "curated_leads",
      });
      return { tenantId, messageId };
    }

    const message = async (id: string) => (await b.db.select().from(b.schema.lifecycleMessages).where(eq(b.schema.lifecycleMessages.id, id)))[0];

    it("posts a signed request and renders the snapshot into the template", async () => {
      seen.length = 0;
      reply = () => ({ status: 200, json: { data: { leads: [{ name: "Acme", url: "https://acme.example/" }, { name: "Beta <Co>", url: "https://beta.example/" }] }, empty: false } });
      const { tenantId, messageId } = await setup({ context: [{ source: "leads", mode: "inferred", limit: 3 }] });
      const r = await processContentTick(b.db, new Date(), 20, [tenantId]);
      expect(r.advanced).toBe(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.verified).toBe(true);
      expect(seen[0]!.body).toMatchObject({
        source: "leads",
        mode: "inferred",
        limit: 3,
        contact: { external_id: "user-1", email: "u1@example.com", traits: { plan_tier: "pro" } },
        flow: { slug: "icp_setup_nudge" },
        step: { order: 1 },
        message_id: messageId,
      });
      expect(typeof seen[0]!.body.product).toBe("string");
      const m = await message(messageId);
      expect(m.status).toBe("pending_approval");
      expect(m.bodyHtml).toContain('<a href="https://acme.example/">Acme</a>');
      expect(m.bodyHtml).toContain("Beta &lt;Co&gt;");
      expect(m.bodyHtml).not.toContain("none");
      expect(m.contextSnapshot).toEqual({ leads: { leads: [{ name: "Acme", url: "https://acme.example/" }, { name: "Beta <Co>", url: "https://beta.example/" }] } });
    });

    it("on_empty skip skips the message; send renders the inverted section", async () => {
      reply = () => ({ status: 200, json: { data: { leads: [] }, empty: true } });
      const a = await setup({ context: [{ source: "leads" }], on_empty: "skip" });
      await processContentTick(b.db, new Date(), 20, [a.tenantId]);
      const ma = await message(a.messageId);
      expect(ma.status).toBe("skipped");
      expect(ma.brainReasoning).toContain("context_empty");

      const s = await setup({ context: [{ source: "leads" }] });
      await processContentTick(b.db, new Date(), 20, [s.tenantId]);
      const ms = await message(s.messageId);
      expect(ms.status).toBe("pending_approval");
      expect(ms.bodyHtml).toContain("<p>none</p>");
    });

    it("on_error: fail, skip and defer (default), and the timeout", async () => {
      reply = () => ({ status: 500 });
      const f = await setup({ context: [{ source: "leads" }], on_error: "fail" });
      await processContentTick(b.db, new Date(), 20, [f.tenantId]);
      expect((await message(f.messageId)).status).toBe("failed");

      const s = await setup({ context: [{ source: "leads" }], on_error: "skip" });
      await processContentTick(b.db, new Date(), 20, [s.tenantId]);
      expect((await message(s.messageId)).status).toBe("skipped");

      reply = () => ({ status: 200, json: { data: { leads: [] } }, delayMs: 600 });
      const d = await setup({ context: [{ source: "leads" }] }, 200);
      const r = await processContentTick(b.db, new Date(), 20, [d.tenantId]);
      expect(r.errors).toBe(1);
      expect((await message(d.messageId)).status).toBe("generating");
    });

    it("a data source without a usable secret fails closed", async () => {
      reply = () => ({ status: 200, json: { data: { leads: [] } } });
      const before = seen.length;
      const { tenantId, messageId } = await setup({ context: [{ source: "leads" }], on_error: "fail" });
      await b.db.update(b.schema.tenants).set({ settings: { data_sources: { leads: { url: `${base}/x`, secret_ref: "CLAROS_TEST_MISSING" } } } }).where(eq(b.schema.tenants.id, tenantId));
      await processContentTick(b.db, new Date(), 20, [tenantId]);
      const m = await message(messageId);
      expect(m.status).toBe("failed");
      expect(m.brainReasoning).toContain("no usable secret");
      expect(seen.length).toBe(before);
    });
  });
}
