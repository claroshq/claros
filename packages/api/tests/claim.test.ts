/**
 * /claim against the claim_tokens table, on a fresh D1 database (Miniflare)
 * so the "no user yet" state is real. The routes are runtime-neutral; the
 * Postgres queries behind them are covered by the store contract tests.
 *
 * - buildApp({ claimToken }) (Node): the token is written to the table on
 *   first use; main.ts writes it at boot with serverMain.replaceClaimToken.
 * - buildApp({ claimFromDatabase }) (Workers) is covered end to end in
 *   apps/worker/tests/worker.e2e.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@claros/db/schema-sqlite";
import { createD1Store, registerStore, type Store } from "@claros/store";
import { buildApp } from "../src/app.js";
import { CLAIM_TOKEN_TTL_MS, hashClaimToken } from "../src/routes/claim.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

let mf: any;
let db: any;
let store: Store;

beforeEach(async () => {
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
  store = createD1Store(db);
  registerStore(db, store);
  // What bootstrapSeed does on a fresh Node install.
  await store.serverMain.bootstrapSeed(null);
}, 60_000);

afterEach(async () => {
  await mf?.dispose();
});

const app = (claimToken: string) =>
  buildApp({ db, logger: false, claimToken, baseUrl: "http://localhost:3000" });

const post = (a: Awaited<ReturnType<typeof app>>, token: string, email = "owner@example.com") =>
  a.inject({
    method: "POST",
    url: "/claim",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `token=${token}&email=${encodeURIComponent(email)}`,
  });

describe("/claim with claim_tokens (Node path)", () => {
  it("stores SHA-256 hex (the deploy CLI computes the same; vector shared with packages/cli/tests/units.test.ts)", () => {
    expect(hashClaimToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("the claimToken option seeds the table (hashed) and the claim works once", async () => {
    const a = await app("tok-seed");
    const page = await a.inject({ method: "GET", url: "/claim?token=tok-seed" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Claim your account");

    const rows = await db.select().from(schema.claimTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashClaimToken("tok-seed"));
    expect(rows[0].tokenHash).not.toContain("tok-seed");
    const ttl = rows[0].expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(CLAIM_TOKEN_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(CLAIM_TOKEN_TTL_MS);

    const res = await post(a, "tok-seed");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("http://localhost:3000/");
    expect(String(res.headers["set-cookie"])).toMatch(/^claros_session=/);
    const [owner] = await db.select().from(schema.users);
    expect(owner).toMatchObject({ email: "owner@example.com", role: "owner", instanceRole: "admin" });
    expect((await db.select().from(schema.claimTokens))[0].consumedAt).toBeInstanceOf(Date);

    // Claimed: both routes send the visitor to login.
    const again = await post(a, "tok-seed", "second@example.com");
    expect(again.statusCode).toBe(302);
    expect(again.headers.location).toBe("http://localhost:3000/login");
    const page2 = await a.inject({ method: "GET", url: "/claim?token=tok-seed" });
    expect(page2.statusCode).toBe(302);
    expect(await db.select().from(schema.users)).toHaveLength(1);
  });

  it("a wrong token is refused (403) and creates nothing", async () => {
    const a = await app("tok-right");
    expect((await a.inject({ method: "GET", url: "/claim?token=tok-wrong" })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: "/claim" })).statusCode).toBe(403);
    expect((await post(a, "tok-wrong")).statusCode).toBe(403);
    expect(await db.select().from(schema.users)).toEqual([]);
  });

  it("an expired token is refused", async () => {
    await db.insert(schema.claimTokens).values({ tokenHash: hashClaimToken("tok-old"), expiresAt: new Date(Date.now() - 1000) });
    // The app's own seed token is a different one; tok-old is only in the table.
    const a = await app("tok-other");
    expect((await a.inject({ method: "GET", url: "/claim?token=tok-old" })).statusCode).toBe(403);
    expect((await post(a, "tok-old")).statusCode).toBe(403);
    expect(await db.select().from(schema.users)).toEqual([]);
  });

  it("a token written at boot (replaceClaimToken) works from any app instance; the previous boot's token does not", async () => {
    await store.serverMain.replaceClaimToken({ tokenHash: hashClaimToken("boot-1"), expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS) });
    await store.serverMain.replaceClaimToken({ tokenHash: hashClaimToken("boot-2"), expiresAt: new Date(Date.now() + CLAIM_TOKEN_TTL_MS) });
    // Another instance that did not mint boot-2 itself.
    const other = await app("instance-b");
    expect((await other.inject({ method: "GET", url: "/claim?token=boot-1" })).statusCode).toBe(403);
    expect((await other.inject({ method: "GET", url: "/claim?token=boot-2" })).statusCode).toBe(200);
  });

  it("concurrent claims with the same token create exactly one owner", async () => {
    const a = await app("tok-race");
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => post(a, "tok-race", `racer${i}-${randomUUID().slice(0, 4)}@example.com`)),
    );
    expect(results.every((r) => r.statusCode === 302)).toBe(true);
    expect(await db.select().from(schema.users)).toHaveLength(1);
    expect(results.filter((r) => r.headers.location === "http://localhost:3000/")).toHaveLength(1);
  });

  it("an invalid email keeps the token usable", async () => {
    const a = await app("tok-email");
    expect((await post(a, "tok-email", "nope")).statusCode).toBe(400);
    const [row] = await db.select().from(schema.claimTokens).where(eq(schema.claimTokens.tokenHash, hashClaimToken("tok-email")));
    expect(row.consumedAt).toBeNull();
    expect((await post(a, "tok-email")).statusCode).toBe(302);
  });
});
