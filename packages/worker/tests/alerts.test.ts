/**
 * Operational alerts end to end on one database: recording, alert mail,
 * repeats, the hourly cap, resolution and the digest (packages/worker/src/alerts.ts).
 *
 * Alert state is instance-wide (the hourly mail cap, every open alert), so
 * each test gets its own fresh in-memory D1 database (Miniflare, the engine
 * wrangler dev uses) instead of the shared Postgres. The Store methods
 * underneath have contract tests on both backends (packages/store/tests/ops.test.ts).
 * No provider is called: the transport is a recording fake.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@claros/db/schema-sqlite";
import { createD1Store, registerStore, storeFor } from "@claros/store";
import { OPS_KIND, QUEUE } from "@claros/core";
import {
  checkLateTicks,
  checkSendErrors,
  recordDeadLetter,
  recordDrainFaults,
  recordJobFailure,
  recordLlmCalls,
  recordTickRun,
  runAlertTick,
  runDigest,
} from "../src/alerts.js";
import type { TenantTransportAdapter, TransportResolver, TransportSendParams } from "../src/transport.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

let mf: any;
let db: any;
let sent: TransportSendParams[];
let sendFails: boolean;
let resolveTransport: TransportResolver;
let tenantId: string;
let transportId: string;
const ADMIN = "ops-admin@example.com";

const T0 = new Date("2026-11-25T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

async function openD1() {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const { drizzle } = await import("drizzle-orm/d1");
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {}", d1Databases: ["DB"] }));
  const d1 = await mf.getD1Database("DB");
  const dir = join(repoRoot, "drizzle", "migrations-sqlite");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await d1.prepare(stmt).run();
    }
  }
  db = drizzle(d1 as never);
  registerStore(db, createD1Store(db));
}

beforeEach(async () => {
  await openD1();
  sent = [];
  sendFails = false;
  tenantId = randomUUID();
  transportId = randomUUID();
  await db.insert(schema.tenants).values({ id: tenantId, name: "Acme", slug: "acme", createdAt: new Date("2026-01-01T00:00:00Z") });
  await db.insert(schema.users).values({ tenantId, email: ADMIN, role: "owner", instanceRole: "admin" });
  const adapter: TenantTransportAdapter = {
    transportInfo: { id: transportId, kind: "resend", fromEmail: "ops@acme.test", fromName: "Acme", replyTo: null, dailyLimit: null },
    async send(params) {
      sent.push(params);
      return sendFails ? { success: false, error: "Resend error 500 (x): down" } : { success: true, providerMessageId: "p" };
    },
  };
  resolveTransport = vi.fn(async () => adapter);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await mf?.dispose();
});

const tick = (minutes: number) => runAlertTick(db, { resolveTransport }, at(minutes));
const alerts = () => storeFor(db).ops.listAlerts({ limit: 1000 });

async function setSetting(key: string, value: unknown) {
  await storeFor(db).ops.putSetting({ key, value, now: T0 });
}

describe("dead letters", () => {
  it("a forced dead letter mails once within one tick", async () => {
    await recordDeadLetter(db, QUEUE.COMPILE, { tenant_id: tenantId, flow_id: randomUUID() }, 4, new Error("boom"), at(0));
    const result = await tick(1);
    expect(result.mailed).toBe(1);
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe(ADMIN);
    expect(mail.from).toBe("ops@acme.test");
    expect(mail.subject).toBe(`[Claros] error: Job ${QUEUE.COMPILE} failed on every retry and was dropped: boom`);
    expect(mail.bodyText).toContain("Product: Acme");
    // Transactional: no List-Unsubscribe.
    expect(mail.headers).toEqual({});
    expect(resolveTransport).toHaveBeenCalledWith(tenantId, "transactional");

    await tick(6);
    await tick(11);
    expect(sent).toHaveLength(1);
  });

  it("50 identical failures in the next hour send no more mail and the digest shows 51", async () => {
    const data = { tenant_id: tenantId, flow_id: "f" };
    await recordDeadLetter(db, QUEUE.COMPILE, data, 4, new Error("boom"), at(0));
    await tick(1);
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 50; i++) {
      await recordDeadLetter(db, QUEUE.COMPILE, { ...data, flow_id: randomUUID() }, 4, new Error("boom"), at(2 + i));
      if (i % 5 === 0) await tick(2 + i);
    }
    await tick(55);
    expect(sent).toHaveLength(1);
    const [alert] = await alerts();
    expect(alert).toMatchObject({ count: 51, notifiedCount: 1, status: "open" });

    const digest = await runDigest(db, { resolveTransport }, at(58));
    expect(digest.sent).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toBe("[Claros] daily digest: 1 open alert");
    expect(sent[1]!.bodyText).toContain(`- 51x error [Acme]: Job ${QUEUE.COMPILE} failed on every retry`);
    expect(sent[1]!.bodyText).toContain("- 51 (dead letters and job failures)");

    // The hourly repeat says how many more occurred since the last mail.
    await tick(61);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.subject).toContain("(50 more since the last mail)");
  });
});

describe("delivery rules", () => {
  it("at most 10 alert mails per hour, then one storm mail; the rest go to the digest", async () => {
    for (let i = 0; i < 13; i++) {
      await recordJobFailure(db, `claros.job-${String.fromCharCode(97 + i)}`, {}, new Error("down"), at(0));
    }
    const first = await tick(1);
    expect(first.mailed).toBe(10);
    expect(first.storm).toBe(true);
    expect(sent).toHaveLength(11);
    expect(sent[10]!.subject).toBe("[Claros] alert storm: 3 more alerts this hour");

    // Still over the cap within the hour: no mail, and no second storm mail.
    await recordJobFailure(db, "claros.job-late", {}, new Error("down"), at(10));
    await tick(11);
    expect(sent).toHaveLength(11);
    await tick(62);
    expect(sent).toHaveLength(11);

    // The alert held back is in the digest (the first 13 resolved after a clean hour).
    await runDigest(db, { resolveTransport }, at(63));
    expect(sent[11]!.subject).toBe("[Claros] daily digest: 1 open alert");
    expect(sent[11]!.bodyText).toContain("Job claros.job-late failed: down");

    // A new occurrence after the hour mails as a repeat.
    await recordJobFailure(db, "claros.job-late", {}, new Error("down"), at(70));
    await tick(72);
    expect(sent).toHaveLength(13);
    expect(sent[12]!.subject).toBe("[Claros] error: Job claros.job-late failed: down (1 more since the last mail)");
  });

  it("critical alerts mail first; a mailed critical alert gets a resolved mail after a clean hour", async () => {
    await recordJobFailure(db, "claros.scan", {}, new Error("x"), at(0));
    await recordDrainFaults(db, [{ tenantId, fault: "no_signing_key" }, { tenantId, fault: "no_signing_key" }], at(0));
    await tick(1);
    expect(sent.map((m) => m.subject)).toEqual([
      "[Claros] critical: UNSUBSCRIBE_SIGNING_KEY is not set: the drain returned approved messages to the queue unsent.",
      "[Claros] error: Job claros.scan failed: x",
    ]);
    const result = await tick(62);
    expect(result.resolved).toBe(2);
    expect(sent).toHaveLength(3);
    expect(sent[2]!.subject).toBe(
      "[Claros] resolved: UNSUBSCRIBE_SIGNING_KEY is not set: the drain returned approved messages to the queue unsent.",
    );
    expect((await alerts()).every((a) => a.status === "resolved")).toBe(true);
  });

  it("alerts disabled sends nothing but the alerts stay listed", async () => {
    await setSetting("alerts.enabled", false);
    await recordDeadLetter(db, QUEUE.COMPILE, { tenant_id: tenantId }, 4, null, at(0));
    const result = await tick(1);
    expect(result.skipped).toBe("disabled");
    expect(sent).toHaveLength(0);
    expect(await alerts()).toHaveLength(1);
    expect((await runDigest(db, { resolveTransport }, at(2))).skipped).toBe("disabled");
    expect(sent).toHaveLength(0);
  });

  it("alerts.email overrides the admin, alerts.via_product picks the product whose transport sends", async () => {
    const other = randomUUID();
    await db.insert(schema.tenants).values({ id: other, name: "Beta", slug: "beta", createdAt: new Date("2026-02-01T00:00:00Z") });
    await setSetting("alerts.email", "oncall@example.com");
    await setSetting("alerts.via_product", "beta");
    await recordJobFailure(db, "claros.scan", {}, new Error("x"), at(0));
    await tick(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("oncall@example.com");
    expect(vi.mocked(resolveTransport).mock.calls[0]).toEqual([other, "transactional"]);
  });

  it("without a usable transport nothing is sent and the alert waits", async () => {
    resolveTransport = vi.fn(async () => null);
    await recordJobFailure(db, "claros.scan", {}, new Error("x"), at(0));
    expect((await tick(1)).skipped).toBe("no_transport");
    expect((await alerts())[0]!.lastNotifiedAt).toBeNull();
  });

  it("a failed alert send is logged and raises no new alert", async () => {
    sendFails = true;
    await recordJobFailure(db, "claros.scan", {}, new Error("x"), at(0));
    const result = await tick(1);
    expect(result.mailed).toBe(0);
    expect(sent).toHaveLength(1);
    expect(await alerts()).toHaveLength(1);
    expect(await storeFor(db).ops.listEvents({ since: at(-60), limit: 100 })).toHaveLength(1);
  });

  it("a muted alert does not mail", async () => {
    await recordJobFailure(db, "claros.scan", {}, new Error("x"), at(0));
    const [a] = await alerts();
    await storeFor(db).ops.muteAlert({ fingerprint: a!.fingerprint, until: at(120) });
    await tick(1);
    expect(sent).toHaveLength(0);
  });
});

describe("send errors", () => {
  async function seedMessages(sentCount: number, failedCount: number, end: number, reason = "provider_error: Resend error 500 (x): down") {
    await db.insert(schema.transportConfigs).values({
      id: transportId,
      tenantId,
      provider: "resend",
      kind: "resend",
      name: "Main",
      config: "{}",
      fromEmail: "ops@acme.test",
      isActive: true,
    });
    const contactId = randomUUID();
    const flowId = randomUUID();
    const membershipId = randomUUID();
    await db.insert(schema.contacts).values({ id: contactId, tenantId, externalId: "c1", lifecycleState: "signed_up" });
    await db.insert(schema.flows).values({ id: flowId, tenantId, name: "F", triggerType: "event", triggerConfig: {}, steps: [], status: "active" });
    await db.insert(schema.flowMemberships).values({ id: membershipId, tenantId, contactId, flowId, currentStep: 1, status: "active", enteredAt: T0 });
    let step = 0;
    const base = { tenantId, contactId, flowId, membershipId, recipientAddress: "a@example.com", transportId };
    for (let i = 0; i < sentCount; i++) {
      await db.insert(schema.lifecycleMessages).values({ ...base, flowStepOrder: ++step, status: "sent", sentAt: at(end - 5), updatedAt: at(end - 5) });
    }
    for (let i = 0; i < failedCount; i++) {
      await db.insert(schema.lifecycleMessages).values({ ...base, flowStepOrder: ++step, status: "failed", statusReason: reason, updatedAt: at(end - 4) });
    }
  }

  it("30% send failures over 15 minutes alert once", async () => {
    await seedMessages(7, 3, 15);
    await checkSendErrors(db, at(15));
    await tick(16);
    await checkSendErrors(db, at(16));
    await tick(21);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe(
      '[Claros] error: More than 20% of sends failed on the resend transport "Main" in the last 15 minutes (3 of 10).',
    );
    const [a] = await alerts();
    expect(a).toMatchObject({ kind: OPS_KIND.SEND_ERROR_RATE, tenantId, count: 2 });
  });

  it("20% or fewer than 10 attempts do not alert", async () => {
    await seedMessages(8, 2, 15);
    await checkSendErrors(db, at(15));
    expect(await alerts()).toHaveLength(0);
  });

  it("a provider auth error is critical", async () => {
    await seedMessages(20, 1, 15, "provider_error: Resend error 401 (restricted_api_key): no send permission");
    await checkSendErrors(db, at(15));
    const list = await alerts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: OPS_KIND.SEND_AUTH, severity: "critical", tenantId });
  });
});

describe("other sources", () => {
  it("LLM errors above 20% raise one warning that is not mailed", async () => {
    await recordLlmCalls(db, tenantId, { calls: 3, errors: 3 }, at(0)); // below the minimum of 5 calls
    expect(await alerts()).toHaveLength(0);
    await recordLlmCalls(db, tenantId, { calls: 3, errors: 0 }, at(1)); // 3 of 6: over
    await recordLlmCalls(db, tenantId, { calls: 1, errors: 1 }, at(2));
    const list = await alerts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: OPS_KIND.LLM_ERROR_RATE, severity: "warning", count: 2 });
    expect(await storeFor(db).ops.listEvents({ since: at(-60), limit: 100 })).toHaveLength(1);
    await tick(3);
    expect(sent).toHaveLength(0);
  });

  it("a periodic job older than three intervals is late", async () => {
    await recordTickRun(db, QUEUE.SCAN, at(0));
    await recordTickRun(db, QUEUE.REAP, at(0));
    expect(await checkLateTicks(db, at(45))).toEqual([]);
    expect(await checkLateTicks(db, at(46))).toEqual(["scan"]);
    // Partition maintenance does not run on D1 and is not judged there.
    await recordTickRun(db, QUEUE.PARTITION_MAINTENANCE, at(-600));
    expect(await checkLateTicks(db, at(46))).toEqual(["scan"]);
    const [a] = await alerts();
    expect(a).toMatchObject({ kind: OPS_KIND.TICK_LATE, count: 2 });
    expect(a!.message).toContain("Periodic job scan is late");
  });

  it("a product without a usable transport is critical", async () => {
    await recordDrainFaults(db, [{ tenantId, fault: "no_transport" }], at(0));
    const [a] = await alerts();
    expect(a).toMatchObject({ kind: OPS_KIND.DRAIN_CONFIG, severity: "critical", tenantId });
  });

  it("the digest is skipped when empty and sent once a day", async () => {
    expect((await runDigest(db, { resolveTransport }, at(0))).skipped).toBe("empty");
    await recordJobFailure(db, "claros.scan", {}, new Error("x"), at(1));
    expect((await runDigest(db, { resolveTransport }, at(2))).sent).toBe(true);
    expect((await runDigest(db, { resolveTransport }, at(3))).skipped).toBe("already_sent");
    expect(sent).toHaveLength(1);
  });

  it("the digest deletes events older than 30 days", async () => {
    await recordJobFailure(db, "claros.scan", {}, new Error("x"), at(-31 * 24 * 60));
    await recordJobFailure(db, "claros.scan", {}, new Error("x"), at(-29 * 24 * 60));
    const result = await runDigest(db, { resolveTransport }, at(0));
    expect(result.deletedEvents).toBe(1);
    const rows = await db.select().from(schema.opsEvents).where(eq(schema.opsEvents.kind, OPS_KIND.JOB_FAILED));
    expect(rows).toHaveLength(1);
  });
});
