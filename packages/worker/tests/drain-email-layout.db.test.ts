/**
 * Drain: the product's email template. A stored template named by
 * brand.template wraps the body with the compliance footer; a built-in key
 * selects that built-in; a deleted template falls back to brand.layout.
 * Requires local Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { tenants, contacts, flows, flowMemberships, lifecycleMessages, emailLayouts } from "@claros/db/schema";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "../src/transport.js";
import { makeDrainRunner } from "./drain-test-utils.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[drain-email-layout.test] DATABASE_URL is not set.");

class Capture implements TransportAdapter {
  sends: TransportSendParams[] = [];
  async send(params: TransportSendParams): Promise<TransportSendResult> {
    this.sends.push(params);
    return { success: true, providerMessageId: `cap-${params.messageId}` };
  }
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let tenantId: string;

const CUSTOM = '<!DOCTYPE html><html><body><div id="custom-shell" style="color:{{accent_color}}">{{brand_name}}</div>{{body}}<footer>{{compliance_footer}}</footer></body></html>';

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL });
  db = drizzle(pool);
  const [t] = await db
    .insert(tenants)
    .values({ name: "Layouts", slug: `test-layout-${randomUUID().slice(0, 8)}`, settings: { postal_address: "1 Test Street, Testville", brand: { brand_name: "Acme", accent_color: "#ff5500" } } })
    .returning({ id: tenants.id });
  tenantId = t!.id;
});

afterAll(async () => {
  for (const table of ["lifecycle_messages", "flow_memberships", "flows", "lifecycle_transitions", "contacts", "email_layouts"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  await pool.end();
});

async function sendOne(brand: Record<string, unknown>, flowTemplate: string | null = null): Promise<string> {
  await db.update(tenants).set({ settings: { postal_address: "1 Test Street, Testville", brand: { brand_name: "Acme", accent_color: "#ff5500", ...brand } } }).where(eq(tenants.id, tenantId));
  const ext = randomUUID().slice(0, 8);
  const [c] = await db.insert(contacts).values({ tenantId, externalId: ext, email: `${ext}@example.com`, lifecycleState: "engaged" }).returning({ id: contacts.id });
  const [f] = await db
    .insert(flows)
    .values({
      tenantId, name: "Welcome", slug: `welcome-${ext}`, triggerType: "manual", triggerConfig: {}, status: "paused", emailTemplate: flowTemplate,
      steps: [{ order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" }],
      compiledPlan: { trigger: { type: "manual", condition: {} }, steps: [{ order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" }] },
    })
    .returning({ id: flows.id });
  const [m] = await db.insert(flowMemberships).values({ tenantId, contactId: c!.id, flowId: f!.id, status: "completed", enteredAt: new Date() }).returning({ id: flowMemberships.id });
  await db.insert(lifecycleMessages).values({
    tenantId, contactId: c!.id, flowId: f!.id, membershipId: m!.id, flowStepOrder: 1, status: "approved",
    subject: "Hi", bodyHtml: "<p>Hello from the body</p>", bodyText: "Hello from the body", approvedAt: new Date(),
  });
  const cap = new Capture();
  const res = await makeDrainRunner(db, tenantId, cap, "drain-layout-signing-key-do-not-use", "http://localhost:3000")(new Date());
  expect(res.sent).toBe(1);
  return cap.sends[0]!.bodyHtml;
}

describe("drain email template", () => {
  it("sends in the stored template brand.template names, with the compliance footer", async () => {
    const [row] = await db.insert(emailLayouts).values({ tenantId, name: "Custom", width: "narrow", source: CUSTOM }).returning({ id: emailLayouts.id });
    const html = await sendOne({ template: row!.id });
    expect(html).toContain('<div id="custom-shell" style="color:#ff5500">Acme</div><p>Hello from the body</p><footer>');
    expect(html).toMatch(/<footer>[\s\S]*http:\/\/localhost:3000\/unsubscribe[\s\S]*1 Test Street, Testville[\s\S]*<\/footer>/);
  });

  it("sends in a built-in template by key", async () => {
    const html = await sendOne({ template: "letter" });
    expect(html).toContain("Georgia,'Times New Roman',Times,serif");
    expect(html).toContain("<p>Hello from the body</p>");
  });

  it("falls back to brand.layout when the stored template is gone", async () => {
    const html = await sendOne({ template: randomUUID(), layout: "wide" });
    expect(html).toContain('<td align="center" style="padding:24px 12px 40px 12px;">');
    expect(html).not.toContain("custom-shell");
  });

  it("sends in the flow's template over the product's", async () => {
    const [row] = await db.insert(emailLayouts).values({ tenantId, name: "Flow", width: "narrow", source: CUSTOM.replace("custom-shell", "flow-shell") }).returning({ id: emailLayouts.id });
    const custom = await sendOne({ template: "letter" }, row!.id);
    expect(custom).toContain('<div id="flow-shell"');
    const builtin = await sendOne({ template: "letter" }, "compact");
    expect(builtin).toContain("max-width:520px");
    expect(builtin).not.toContain("Georgia");
  });

  it("falls back to the product's template when the flow's template is gone", async () => {
    const html = await sendOne({ template: "letter" }, randomUUID());
    expect(html).toContain("Georgia,'Times New Roman',Times,serif");
  });
});
