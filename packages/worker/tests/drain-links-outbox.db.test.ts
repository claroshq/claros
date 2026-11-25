/**
 * Drain: UTM tagging of product links (G6) and the message.sent outbox row
 * (G5) written with the sent transition. Requires local Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { tenants, contacts, flows, flowMemberships, lifecycleMessages, webhookEndpoints, webhookOutbox } from "@claros/db/schema";
import type { TransportAdapter, TransportSendParams, TransportSendResult } from "../src/transport.js";
import { makeDrainRunner } from "./drain-test-utils.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) throw new Error("[drain-links-outbox.test] DATABASE_URL is not set.");

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

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL });
  db = drizzle(pool);
  const [t] = await db
    .insert(tenants)
    .values({
      name: "Links",
      slug: `test-links-${randomUUID().slice(0, 8)}`,
      settings: {
        postal_address: "1 Test Street, Testville",
        link_tracking: {
          domains: ["fundup.ai"],
          params: { utm_source: "claros", utm_medium: "email", utm_campaign: "{{flow.slug}}", utm_content: "step-{{step.order}}" },
          click_id: true,
        },
      },
    })
    .returning({ id: tenants.id });
  tenantId = t!.id;
});

afterAll(async () => {
  for (const table of ["webhook_outbox", "webhook_endpoints", "lifecycle_messages", "flow_memberships", "flows", "lifecycle_transitions", "contacts"]) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  await pool.end();
});

describe("drain link tagging and outbox", () => {
  it("tags product links in html and text, leaves other links and the unsubscribe link; writes message.sent", async () => {
    const [c] = await db.insert(contacts).values({ tenantId, externalId: "u1", email: "u1@example.com", lifecycleState: "engaged" }).returning({ id: contacts.id });
    const [f] = await db
      .insert(flows)
      .values({
        tenantId, name: "Welcome", slug: "welcome", triggerType: "manual", triggerConfig: {}, status: "paused",
        steps: [{ order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" }],
        compiledPlan: { trigger: { type: "manual", condition: {} }, steps: [{ order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" }] },
      })
      .returning({ id: flows.id });
    const [m] = await db.insert(flowMemberships).values({ tenantId, contactId: c!.id, flowId: f!.id, status: "completed", enteredAt: new Date() }).returning({ id: flowMemberships.id });
    const [msg] = await db
      .insert(lifecycleMessages)
      .values({
        tenantId, contactId: c!.id, flowId: f!.id, membershipId: m!.id, flowStepOrder: 1, status: "approved",
        subject: "Hi",
        bodyHtml: '<p><a href="https://app.fundup.ai/icp?x=1&amp;utm_source=keep">Set up</a> <a href="https://example.com/a">Other</a></p>',
        bodyText: "Set up: https://fundup.ai/icp. Other: https://example.com/a",
        approvedAt: new Date(),
      })
      .returning({ id: lifecycleMessages.id });
    const [ep] = await db.insert(webhookEndpoints).values({ tenantId, slug: "hooks", url: "http://127.0.0.1:9/claros", events: ["message.sent"] }).returning({ id: webhookEndpoints.id });

    const cap = new Capture();
    const run = makeDrainRunner(db, tenantId, cap, "drain-links-signing-key-do-not-use", "http://localhost:3000");
    const res = await run(new Date());
    expect(res.sent).toBe(1);
    const sent = cap.sends[0]!;
    // Settings are jsonb (key order not kept), so compare the parameters, not their order.
    const href = /href="(https:\/\/app\.fundup\.ai[^"]*)"/.exec(sent.bodyHtml)![1]!.replace(/&amp;/g, "&");
    expect(Object.fromEntries(new URL(href).searchParams)).toEqual({
      x: "1", utm_source: "keep", utm_medium: "email", utm_campaign: "welcome", utm_content: "step-1", clr_cid: msg!.id,
    });
    expect(sent.bodyHtml).toContain('href="https://example.com/a"');
    const textUrl = /(https:\/\/fundup\.ai\/icp\?[^\s]*)\. Other/.exec(sent.bodyText!)![1]!;
    expect(Object.fromEntries(new URL(textUrl).searchParams)).toEqual({
      utm_source: "claros", utm_medium: "email", utm_campaign: "welcome", utm_content: "step-1", clr_cid: msg!.id,
    });
    expect(sent.bodyText).toContain("https://example.com/a");
    // The unsubscribe link (footer) is never tagged.
    const unsub = /href="(http:\/\/localhost:3000\/unsubscribe[^"]*)"/.exec(sent.bodyHtml)?.[1] ?? "";
    expect(unsub).not.toBe("");
    expect(unsub).not.toContain("utm_");
    // The stored row is unchanged.
    const [stored] = await db.select().from(lifecycleMessages).where(eq(lifecycleMessages.id, msg!.id));
    expect(stored!.bodyHtml).not.toContain("utm_campaign");
    expect(stored!.status).toBe("sent");
    const out = await db.select().from(webhookOutbox).where(eq(webhookOutbox.endpointId, ep!.id));
    expect(out.map((o) => [o.event, (o.payload as { message_id: string }).message_id])).toEqual([["message.sent", msg!.id]]);
  });
});
