/**
 * Unsubscribe pages on a product's public host (D1 via Miniflare; the
 * routes are runtime-neutral and the host lookup has Postgres and D1
 * contract tests in packages/store).
 *
 * A request on a product's public host is answered only for that product's
 * tokens (404 otherwise, nothing suppressed). The instance host serves every
 * product, so links mailed before a public host was set keep working.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@claros/db/schema-sqlite";
import { createD1Store, registerStore } from "@claros/store";
import { generateUnsubscribeToken } from "@claros/adapters";
import { buildApp, type ClarosApp } from "../src/app.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const KEY = "public-host-test-signing-key-not-for-production";
const HOST = "news.hosted.example.com";

let mf: any;
let db: any;
let app: ClarosApp;
let hosted: string;
let plain: string;
const prevKey = process.env.UNSUBSCRIBE_SIGNING_KEY;

async function sentMessage(tenantId: string, email: string): Promise<string> {
  const contactId = randomUUID();
  const flowId = randomUUID();
  const membershipId = randomUUID();
  const id = randomUUID();
  await db.insert(schema.contacts).values({ id: contactId, tenantId, externalId: `x-${contactId}`, email, lifecycleState: "signed_up" });
  await db.insert(schema.flows).values({ id: flowId, tenantId, name: "F", triggerType: "event", triggerConfig: {}, steps: [] });
  await db.insert(schema.flowMemberships).values({ id: membershipId, tenantId, contactId, flowId, enteredAt: new Date() });
  await db.insert(schema.lifecycleMessages).values({
    id,
    tenantId,
    contactId,
    flowId,
    membershipId,
    flowStepOrder: 1,
    status: "sent",
    recipientAddress: email,
  });
  return generateUnsubscribeToken(tenantId, id, KEY);
}

const suppressed = async (tenantId: string) =>
  (await db.select().from(schema.suppressions).where(eq(schema.suppressions.tenantId, tenantId))).map(
    (r: { email: string }) => r.email,
  );

const oneClick = (host: string, token: string) =>
  app.fetch(
    new Request(`https://${host}/unsubscribe/one-click?token=${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }),
  );

beforeAll(async () => {
  process.env.UNSUBSCRIBE_SIGNING_KEY = KEY;
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {}", d1Databases: ["DB"] }));
  const d1 = await mf.getD1Database("DB");
  const dir = join(repoRoot, "drizzle", "migrations-sqlite");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await d1.prepare(stmt).run();
    }
  }
  const { drizzle } = await import("drizzle-orm/d1");
  db = drizzle(d1 as never);
  registerStore(db, createD1Store(db));
  hosted = randomUUID();
  plain = randomUUID();
  await db.insert(schema.tenants).values({ id: hosted, name: "Hosted", slug: "hosted", publicHost: HOST });
  await db.insert(schema.tenants).values({ id: plain, name: "Plain", slug: "plain" });
  app = await buildApp({ db, logger: false, baseUrl: "https://claros.example.com" });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
  if (prevKey === undefined) delete process.env.UNSUBSCRIBE_SIGNING_KEY;
  else process.env.UNSUBSCRIBE_SIGNING_KEY = prevKey;
});

describe("unsubscribe on a product public host", () => {
  it("one-click: the host's own product is served; another product's token is 404 and suppresses nothing", async () => {
    const own = await sentMessage(hosted, "own@example.com");
    const foreign = await sentMessage(plain, "foreign@example.com");

    const ok = await oneClick(HOST, own);
    expect(ok.status).toBe(200);
    expect(await suppressed(hosted)).toEqual(["own@example.com"]);

    const res = await oneClick(HOST, foreign);
    expect(res.status).toBe(404);
    expect(await suppressed(plain)).toEqual([]);
  });

  it("the instance host serves every product, including one with a public host (older links)", async () => {
    const own = await sentMessage(hosted, "old-link@example.com");
    const foreign = await sentMessage(plain, "plain@example.com");
    expect((await oneClick("claros.example.com", own)).status).toBe(200);
    expect((await oneClick("claros.example.com", foreign)).status).toBe(200);
    expect(await suppressed(hosted)).toContain("old-link@example.com");
    expect(await suppressed(plain)).toContain("plain@example.com");
  });

  it("GET page and browser POST apply the same host rule", async () => {
    const own = await sentMessage(hosted, "page-own@example.com");
    const foreign = await sentMessage(plain, "page-foreign@example.com");

    expect((await app.fetch(new Request(`https://${HOST}/unsubscribe?token=${own}`))).status).toBe(200);
    expect((await app.fetch(new Request(`https://${HOST}/unsubscribe?token=${foreign}`))).status).toBe(404);
    // Host names compare case-insensitively.
    expect((await app.fetch(new Request(`https://NEWS.Hosted.example.com/unsubscribe?token=${foreign}`))).status).toBe(404);

    const post = (token: string) =>
      app.fetch(
        new Request(`https://${HOST}/unsubscribe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        }),
      );
    expect((await post(foreign)).status).toBe(404);
    expect(await suppressed(plain)).not.toContain("page-foreign@example.com");
    expect((await post(own)).status).toBe(200);
    expect(await suppressed(hosted)).toContain("page-own@example.com");
  });

  it("an invalid token on a public host is still the opaque 400", async () => {
    expect((await oneClick(HOST, "not-a-token")).status).toBe(400);
  });
});
