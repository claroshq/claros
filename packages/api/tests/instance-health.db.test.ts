/**
 * Health page API and alert recording in the API (G25), on Postgres.
 *
 *   - GET /v1/instance/health: instance admins only; open alerts with their
 *     product, recent events, last run per periodic job, failed-job count,
 *     alert settings (an alert recorded while alerts are disabled is listed)
 *   - POST /v1/instance/alerts/:fingerprint/resolve and /mute
 *   - PUT /v1/instance/settings/alerts.* validation
 *   - 20 bad Resend webhook signatures for a product: one error event, the
 *     alert kept fresh by the rest
 *
 * The database is shared with other suites: assertions look at this test's
 * products and fingerprints only, and the alert settings are restored.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { buildApp } from "../src/index.js";
import { instanceSettings, memberships, opsAlerts, opsEvents, sessions, tenants, users } from "@claros/db/schema";
import { encrypt, parseEncryptionKey } from "@claros/adapters";
import { OPS_KIND, opsFingerprint, windowStartMs } from "@claros/core";
import { storeFor } from "@claros/store";
import type { ClarosApp } from "../src/index.js";

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error("[instance-health.test] DATABASE_URL is not set (see .env.example).");
}

const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const pool = new pg.Pool({ connectionString: TEST_DB_URL });
const db = drizzle(pool);
let app: ClarosApp;
let tenantId: string;
let adminSession: string;
let memberSession: string;
let savedSettings: Array<{ key: string; value: unknown }> = [];
const ALERT_KEYS = ["alerts.enabled", "alerts.email", "alerts.via_product", "tick.scan"];

async function newSession(userId: string): Promise<string> {
  const [s] = await db
    .insert(sessions)
    .values({ tenantId, userId, expiresAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: sessions.id });
  return s!.id;
}

const get = (url: string, session?: string) =>
  app.inject({ method: "GET", url, cookies: session ? { claros_session: session } : {} });
const send = (method: "POST" | "PUT", url: string, session: string, payload?: unknown) =>
  app.inject({ method, url, cookies: { claros_session: session }, payload: payload as never });

beforeAll(async () => {
  vi.stubEnv("ENCRYPTION_KEY", ENCRYPTION_KEY);
  app = await buildApp({ logger: false, db: db as never });
  const [t] = await db.insert(tenants).values({ name: `Health ${RUN}`, slug: `health-${RUN}`, plan: "free" }).returning({ id: tenants.id });
  tenantId = t!.id;
  const [admin] = await db
    .insert(users)
    .values({ tenantId, email: `health-admin-${RUN}@test.local`, role: "owner", instanceRole: "admin" })
    .returning({ id: users.id });
  const [member] = await db
    .insert(users)
    .values({ tenantId, email: `health-member-${RUN}@test.local`, role: "owner" })
    .returning({ id: users.id });
  await db.insert(memberships).values([
    { userId: admin!.id, tenantId, role: "owner" },
    { userId: member!.id, tenantId, role: "owner" },
  ]);
  adminSession = await newSession(admin!.id);
  memberSession = await newSession(member!.id);
  savedSettings = await db
    .select({ key: instanceSettings.key, value: instanceSettings.value })
    .from(instanceSettings)
    .where(inArray(instanceSettings.key, ALERT_KEYS));
});

afterAll(async () => {
  // Leave no open test alerts behind (a dev server on this database would mail them).
  await db.delete(opsAlerts).where(or(eq(opsAlerts.tenantId, tenantId), like(opsAlerts.message, `%${RUN}%`)));
  await db.delete(opsEvents).where(or(eq(opsEvents.tenantId, tenantId), like(opsEvents.message, `%${RUN}%`)));
  await db.delete(instanceSettings).where(eq(instanceSettings.key, `webhook.window.${tenantId}`));
  await db.delete(instanceSettings).where(inArray(instanceSettings.key, ALERT_KEYS));
  for (const s of savedSettings) await db.insert(instanceSettings).values({ key: s.key, value: s.value });
  vi.unstubAllEnvs();
  await app.close();
  await pool.end();
});

describe("GET /v1/instance/health", () => {
  it("is for instance admins only", async () => {
    expect((await get("/v1/instance/health")).statusCode).toBe(401);
    expect((await get("/v1/instance/health", memberSession)).statusCode).toBe(403);
  });

  it("lists an alert recorded while alerts are disabled, with its product and the settings", async () => {
    expect((await send("PUT", "/v1/instance/settings/alerts.enabled", adminSession, { value: false })).statusCode).toBe(200);
    const message = `Job claros.compile failed on every retry and was dropped: health ${RUN}`;
    const fingerprint = opsFingerprint(OPS_KIND.DEAD_LETTER, tenantId, message);
    await storeFor(db).ops.recordEvent(
      { at: new Date(), tenantId, kind: OPS_KIND.DEAD_LETTER, severity: "error", fingerprint, message, context: { job: "claros.compile" } },
      { alert: true },
    );
    await storeFor(db).ops.putSetting({ key: "tick.scan", value: { last_run_at: new Date().toISOString() }, now: new Date() });

    const res = await get("/v1/instance/health", adminSession);
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.settings).toMatchObject({ enabled: false });
    expect(typeof body.failed_jobs_24h).toBe("number");
    expect(body.failed_jobs_24h).toBeGreaterThanOrEqual(1);
    const alert = body.alerts.open.find((a: any) => a.fingerprint === fingerprint);
    expect(alert).toMatchObject({
      kind: "dead_letter",
      severity: "error",
      message,
      status: "open",
      count: 1,
      last_notified_at: null,
      muted_until: null,
      product: { id: tenantId, slug: `health-${RUN}`, name: `Health ${RUN}` },
    });
    expect(body.events.some((e: any) => e.fingerprint === fingerprint && e.context?.job === "claros.compile")).toBe(true);
    const scan = body.ticks.find((t: any) => t.name === "scan");
    expect(scan).toMatchObject({ interval_minutes: 15, late: false });
    expect(typeof scan.last_run_at).toBe("string");
    // Postgres runs partition maintenance.
    expect(body.ticks.map((t: any) => t.name)).toContain("partition-maintenance");
  });
});

describe("resolve and mute", () => {
  async function newAlert(tag: string) {
    // Fingerprints carry "|", spaces and "/": the path segment is URL-encoded.
    const message = `Job claros.scan failed: /v1/${tag} ${RUN}`;
    const fingerprint = opsFingerprint(OPS_KIND.JOB_FAILED, null, message);
    await storeFor(db).ops.recordEvent(
      { at: new Date(), tenantId: null, kind: OPS_KIND.JOB_FAILED, severity: "error", fingerprint, message },
      { alert: true },
    );
    return fingerprint;
  }

  it("resolves an open alert", async () => {
    const fingerprint = await newAlert("resolve");
    const res = await send("POST", `/v1/instance/alerts/${encodeURIComponent(fingerprint)}/resolve`, adminSession);
    expect(res.statusCode).toBe(200);
    expect((res.json() as any).alert).toMatchObject({ fingerprint, status: "resolved" });
    const [row] = await db.select().from(opsAlerts).where(eq(opsAlerts.fingerprint, fingerprint));
    expect(row!.status).toBe("resolved");
    // Resolving again answers with the resolved alert.
    expect((await send("POST", `/v1/instance/alerts/${encodeURIComponent(fingerprint)}/resolve`, adminSession)).statusCode).toBe(200);
    expect((await send("POST", `/v1/instance/alerts/${encodeURIComponent(`nope-${RUN}`)}/resolve`, adminSession)).statusCode).toBe(404);
  });

  it("mutes an alert for whole hours", async () => {
    const fingerprint = await newAlert("mute");
    const url = `/v1/instance/alerts/${encodeURIComponent(fingerprint)}/mute`;
    expect((await send("POST", url, adminSession, { hours: 0 })).statusCode).toBe(400);
    expect((await send("POST", url, adminSession, { hours: "2" })).statusCode).toBe(400);
    const before = Date.now();
    const res = await send("POST", url, adminSession, { hours: 2 });
    expect(res.statusCode).toBe(200);
    const until = new Date((res.json() as any).alert.muted_until).getTime();
    expect(until).toBeGreaterThanOrEqual(before + 2 * 3600_000 - 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + 2 * 3600_000 + 1000);
    expect((await send("POST", `/v1/instance/alerts/${encodeURIComponent(`nope-${RUN}`)}/mute`, adminSession, { hours: 1 })).statusCode).toBe(404);
    expect((await send("POST", url, memberSession, { hours: 1 })).statusCode).toBe(403);
    await storeFor(db).ops.resolveAlert({ fingerprint });
  });
});

describe("alert settings", () => {
  it("validates alerts.enabled, alerts.email and alerts.via_product", async () => {
    const put = (key: string, value: unknown) => send("PUT", `/v1/instance/settings/${key}`, adminSession, { value });
    expect((await put("alerts.enabled", "yes")).statusCode).toBe(400);
    expect((await put("alerts.enabled", true)).statusCode).toBe(200);
    expect((await put("alerts.email", "not-an-email")).statusCode).toBe(400);
    const ok = await put("alerts.email", "  oncall@example.com ");
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as any).value).toBe("oncall@example.com");
    expect((await put("alerts.email", "")).statusCode).toBe(200);
    expect((await put("alerts.via_product", `missing-${RUN}`)).statusCode).toBe(400);
    expect((await put("alerts.via_product", `health-${RUN}`)).statusCode).toBe(200);
    expect((await put("alerts.mail_log", { sent: [] })).statusCode).toBe(400);

    const body = (await get("/v1/instance/health", adminSession)).json() as any;
    expect(body.settings).toMatchObject({ enabled: true, email: null, via_product: `health-${RUN}` });
  });
});

describe("Resend webhook failures", () => {
  it("20 bad signatures record one error event; the rest keep the alert fresh", async () => {
    const secret = randomBytes(24).toString("base64");
    const config = encrypt(JSON.stringify({ apiKey: "re_test", webhookSecret: secret }), parseEncryptionKey(ENCRYPTION_KEY));
    await db.execute(sql`
      INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email)
      VALUES (${tenantId}::uuid, 'resend', ${config}::jsonb, true, 'noreply@health.test')
    `);
    const payload = JSON.stringify({ type: "email.opened", data: { email_id: `re_${randomUUID()}` } });
    // Freeze the clock one minute into the current 15-minute window so all 20 land in one window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(windowStartMs(new Date(), 15) + 60_000);
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/webhooks/resend/${tenantId}`,
        payload,
        headers: {
          "content-type": "application/json",
          "svix-id": `msg_${i}`,
          "svix-timestamp": String(Math.floor(Date.now() / 1000)),
          "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      });
      expect(res.statusCode).toBe(400);
    }
    vi.useRealTimers();
    const events = await db
      .select()
      .from(opsEvents)
      .where(and(eq(opsEvents.tenantId, tenantId), eq(opsEvents.kind, OPS_KIND.WEBHOOK_FAILURES)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: "error" });
    const [alert] = await db.select().from(opsAlerts).where(eq(opsAlerts.fingerprint, events[0]!.fingerprint));
    expect(alert).toMatchObject({ status: "open", count: 11, kind: OPS_KIND.WEBHOOK_FAILURES });

    // A request for a product without a webhook secret is not counted.
    const unknown = randomUUID();
    await app.inject({ method: "POST", url: `/webhooks/resend/${unknown}`, payload, headers: { "content-type": "application/json" } });
    const counters = await db.select().from(instanceSettings).where(eq(instanceSettings.key, `webhook.window.${unknown}`));
    expect(counters).toHaveLength(0);
  });
});
