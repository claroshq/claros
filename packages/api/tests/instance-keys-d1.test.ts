/**
 * Item 11 on a fresh D1 database (Miniflare): capabilities report d1 and
 * workers, an instance key creates a product, gives it an admin key, and
 * erases a person in every product. The Postgres path is covered by
 * instance-keys.db.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import * as schema from "@claros/db/schema-sqlite";
import { createD1Store, registerStore } from "@claros/store";
import { buildApp } from "../src/app.js";
import { hashApiKey } from "../src/http/ingest-auth.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

let mf: any;
let db: any;

beforeAll(async () => {
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
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

async function instanceKey(scopes: string[]): Promise<string> {
  const raw = `clr_ik_${randomBytes(32).toString("base64url")}`;
  await db.insert(schema.apiKeys).values({ id: randomUUID(), tenantId: null, keyHash: hashApiKey(raw), prefix: raw.slice(0, 8), kind: "instance", scopes });
  return raw;
}

const json = (raw: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${raw}`, "content-type": "application/json", ...extra });

describe("instance keys on D1", () => {
  it("reports d1 / workers capabilities", async () => {
    const a = await buildApp({ db, logger: false, runtime: "workers" });
    const ik = await instanceKey(["instance:read"]);
    const res = await a.inject({ method: "GET", url: "/v1/capabilities", headers: { authorization: `Bearer ${ik}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ backend: "d1", runtime: "workers", kb: { semantic: true }, events: { partitioned: false } });
  });

  it("creates a product, gives it an admin key and erases a person everywhere", async () => {
    const a = await buildApp({ db, logger: false });
    const ik = await instanceKey(["products:write", "keys:write", "people:erase"]);
    const slug = `d1-${randomUUID().slice(0, 8)}`;
    const created = await a.inject({ method: "POST", url: "/v1/products", headers: json(ik), payload: { name: "On D1", slug } });
    expect(created.statusCode).toBe(201);
    const productId = created.json().product.id;

    const key = await a.inject({ method: "POST", url: "/v1/ingestion/keys", headers: json(ik, { "x-claros-product": slug }), payload: { kind: "admin", scopes: ["config"] } });
    expect(key.statusCode).toBe(201);
    expect((await a.inject({ method: "GET", url: "/v1/flows", headers: { authorization: `Bearer ${key.json().key}` } })).statusCode).toBe(200);

    const otherId = randomUUID();
    await db.insert(schema.tenants).values({ id: otherId, name: "Other", slug: `o-${otherId.slice(0, 8)}` });
    await db.insert(schema.contacts).values({ id: randomUUID(), tenantId: productId, externalId: "a", email: "Person@Example.com", lifecycleState: "signed_up" });
    await db.insert(schema.contacts).values({ id: randomUUID(), tenantId: otherId, externalId: "b", email: "person@example.com", lifecycleState: "signed_up" });
    const erased = await a.inject({ method: "DELETE", url: "/v1/instance/people/person%40example.com", headers: { authorization: `Bearer ${ik}` } });
    expect(erased.statusCode).toBe(200);
    expect(erased.json().count).toBe(2);
    expect(await db.select().from(schema.contacts)).toHaveLength(0);
  });
});
