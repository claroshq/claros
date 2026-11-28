/**
 * Contract tests of /v1/analytics-sink, run on every backend:
 * analytics-sink.db.test.ts (Postgres) and analytics-sink-d1.test.ts (D1 in
 * Miniflare). Fixtures are inserted with the backend's schema objects and
 * explicit ids, so the same code seeds either database.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { decrypt, parseEncryptionKey } from "@claros/adapters";
import { hashApiKey } from "../../src/http/ingest-auth.js";

export interface AnalyticsSinkHarness {
  app: { fetch(req: Request): Response | Promise<Response> };
  db: any;
  schema: any;
}

/** Label of every key these tests create, and the slug prefix of their products (for cleanup). */
export const SINK_TEST_LABEL = "analytics-sink-test";
export const SINK_TEST_SLUG_PREFIX = "sink-";

const ENCRYPTION_KEY = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="; // tests only
const BASE = "http://localhost:3000";

export function analyticsSinkContract(name: string, open: () => Promise<AnalyticsSinkHarness>): void {
  describe(`/v1/analytics-sink on ${name}`, () => {
    let h: AnalyticsSinkHarness;
    let s: any;
    let tenantId: string;
    let owner: string;
    let member: string;
    let configKey: string;
    let otherKey: string;
    let savedKey: string | undefined;

    async function session(tid: string, role: "owner" | "member") {
      const userId = randomUUID();
      await h.db.insert(s.users).values({ id: userId, tenantId: tid, email: `${role}-${userId.slice(0, 8)}@example.com`, role });
      const id = randomUUID();
      await h.db.insert(s.sessions).values({ id, tenantId: tid, userId, expiresAt: new Date(Date.now() + 86_400_000) });
      return `claros_session=${id}`;
    }

    async function key(tid: string, scopes: string[]) {
      const raw = `clr_ak_${randomBytes(24).toString("base64url")}`;
      await h.db.insert(s.apiKeys).values({ id: randomUUID(), tenantId: tid, keyHash: hashApiKey(raw), prefix: raw.slice(0, 8), label: SINK_TEST_LABEL, kind: "admin", scopes });
      return raw;
    }

    function call(method: string, path: string, auth: { cookie?: string; key?: string }, body?: unknown) {
      const headers: Record<string, string> = {};
      if (auth.cookie) headers.cookie = auth.cookie;
      if (auth.key) headers.authorization = `Bearer ${auth.key}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      return h.app.fetch(new Request(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    }

    async function endpointRow() {
      const rows = await h.db.select().from(s.webhookEndpoints).where(and(eq(s.webhookEndpoints.tenantId, tenantId), eq(s.webhookEndpoints.slug, "analytics")));
      return rows[0] ?? null;
    }

    async function version(): Promise<number> {
      const rows = await h.db.select().from(s.tenants).where(eq(s.tenants.id, tenantId));
      return rows[0].configVersion;
    }

    beforeAll(async () => {
      savedKey = process.env.ENCRYPTION_KEY;
      process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
      h = await open();
      s = h.schema;
      tenantId = randomUUID();
      await h.db.insert(s.tenants).values({ id: tenantId, name: "Sink test", slug: `${SINK_TEST_SLUG_PREFIX}${tenantId.slice(0, 8)}` });
      owner = await session(tenantId, "owner");
      member = await session(tenantId, "member");
      configKey = await key(tenantId, ["config"]);
      otherKey = await key(tenantId, ["messages"]);
    }, 120_000);

    afterAll(() => {
      if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = savedKey;
    });

    it("lets members read, and only owners and config keys change it", async () => {
      expect((await call("GET", "/v1/analytics-sink", {})).status).toBe(401);
      expect((await call("GET", "/v1/analytics-sink", { key: otherKey })).status).toBe(403);
      const asMember = await call("GET", "/v1/analytics-sink", { cookie: member });
      expect(asMember.status).toBe(200);
      expect(await asMember.json()).toEqual({ analytics_sink: null, sinks: ["statsraven", "webhook"], editable: false });
      const asKey = await call("GET", "/v1/analytics-sink", { key: configKey });
      expect((await asKey.json()).editable).toBe(true);
      const body = { sink: "statsraven", endpoint: "https://stats.example.com", secret: "sr-ingest-token" };
      expect((await call("PUT", "/v1/analytics-sink", { cookie: member }, body)).status).toBe(403);
      expect((await call("DELETE", "/v1/analytics-sink", { cookie: member })).status).toBe(403);
      expect((await call("PUT", "/v1/analytics-sink", { key: otherKey }, body)).status).toBe(403);
    });

    it("validates the body with the settings.analytics schema", async () => {
      for (const bad of [
        { sink: "segment", endpoint: "https://x.example.com" },
        { sink: "statsraven", endpoint: "ftp://x.example.com" },
        { sink: "statsraven" },
        { sink: "statsraven", endpoint: "https://x.example.com", secret: "short" },
        { sink: "statsraven", endpoint: "https://x.example.com", extra: true },
      ]) {
        const res = await call("PUT", "/v1/analytics-sink", { cookie: owner }, bad);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe("Validation failed");
      }
      expect(await endpointRow()).toBeNull();
    });

    it("answers 503 for a secret without ENCRYPTION_KEY", async () => {
      delete process.env.ENCRYPTION_KEY;
      try {
        const res = await call("PUT", "/v1/analytics-sink", { cookie: owner }, { sink: "statsraven", endpoint: "https://stats.example.com", secret: "sr-ingest-token" });
        expect(res.status).toBe(503);
      } finally {
        process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
      }
      expect(await endpointRow()).toBeNull();
    });

    it("sets the sink, stores the secret encrypted and never returns it", async () => {
      const v0 = await version();
      const res = await call("PUT", "/v1/analytics-sink", { cookie: owner }, { sink: "statsraven", endpoint: "https://stats.example.com", secret: "sr-ingest-token" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.analytics_sink).toMatchObject({ sink: "statsraven", endpoint: "https://stats.example.com", has_secret: true, enabled: true });
      expect(JSON.stringify(body)).not.toContain("sr-ingest-token");
      expect(body.changes).toEqual([{ kind: "analytics", key: "analytics", action: "create" }]);
      expect(body.config_version).toBe(v0 + 1);
      const row = await endpointRow();
      expect(row).toMatchObject({ kind: "analytics", url: "https://stats.example.com", config: { sink: "statsraven" } });
      expect(row.secret).not.toContain("sr-ingest-token");
      expect(decrypt(row.secret, parseEncryptionKey(ENCRYPTION_KEY))).toBe("sr-ingest-token");

      const read = await (await call("GET", "/v1/analytics-sink", { cookie: member })).json();
      expect(read.analytics_sink).toMatchObject({ sink: "statsraven", has_secret: true });
      expect(read.analytics_sink.secret).toBeUndefined();

      const listed = await (await call("GET", "/v1/webhooks", { cookie: owner })).json();
      expect(listed.webhooks.find((w: { slug: string }) => w.slug === "analytics")).toMatchObject({ kind: "analytics", read_only: true, sink: "statsraven", has_secret: true });

      const doc = await (await call("GET", "/v1/config", { key: configKey })).json();
      expect(doc.settings.analytics).toEqual({ sink: "statsraven", endpoint: "https://stats.example.com" });
    });

    it("keeps the secret when it is left out, and changes nothing when nothing changed", async () => {
      const before = await endpointRow();
      const res = await call("PUT", "/v1/analytics-sink", { key: configKey }, { sink: "webhook", endpoint: "https://hooks.example.com/claros" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.analytics_sink).toMatchObject({ sink: "webhook", endpoint: "https://hooks.example.com/claros", has_secret: true });
      const after = await endpointRow();
      expect(after.id).toBe(before.id);
      expect(after.secret).toBe(before.secret);

      const v = await version();
      const again = await call("PUT", "/v1/analytics-sink", { key: configKey }, { sink: "webhook", endpoint: "https://hooks.example.com/claros" });
      expect((await again.json()).changes).toEqual([]);
      expect(await version()).toBe(v);

      // The config apply sees what this route wrote as its own: the same settings.analytics is an empty diff.
      const applied = await call("PUT", "/v1/config", { key: configKey }, { version: 1, settings: { analytics: { sink: "webhook", endpoint: "https://hooks.example.com/claros", secret: "sr-ingest-token" } } });
      expect(applied.status).toBe(200);
      expect((await applied.json()).changes).toEqual([]);
    });

    it("removes the sink", async () => {
      const v = await version();
      const res = await call("DELETE", "/v1/analytics-sink", { cookie: owner });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, config_version: v + 1 });
      expect(await endpointRow()).toBeNull();
      expect((await (await call("GET", "/v1/analytics-sink", { key: configKey })).json()).analytics_sink).toBeNull();
      expect((await call("DELETE", "/v1/analytics-sink", { key: configKey })).status).toBe(404);
    });
  });
}
