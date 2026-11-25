/**
 * The (tenant_id, lower(email)) unique index on suppressions (Postgres
 * migration 0013, SQLite migration 0003) refuses a case-variant duplicate on
 * every backend, and stays per tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`suppressions lower(email) unique index on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const insert = (tenantId: string, email: string) =>
      b.db.insert(b.schema.suppressions).values({ tenantId, email, reason: "manual" });

    it("refuses a case-variant duplicate in the same tenant", async () => {
      const t = await b.newTenant();
      await insert(t, "Ann@Example.com");
      await expect(insert(t, "ann@example.COM")).rejects.toThrow();
      await expect(insert(t, "Ann@Example.com")).rejects.toThrow();
      const rows = await b.db.select().from(b.schema.suppressions).where(eq(b.schema.suppressions.tenantId, t));
      expect(rows.map((r: { email: string }) => r.email)).toEqual(["Ann@Example.com"]);
    });

    it("allows the same address in another tenant and other addresses in the same tenant", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      await insert(t, "bob@example.com");
      await insert(other, "BOB@example.com");
      await insert(t, "bob2@example.com");
      expect(await b.db.select().from(b.schema.suppressions).where(eq(b.schema.suppressions.tenantId, t))).toHaveLength(2);
    });
  });
}

describe("SQLite migration 0003_suppressions_lower_email", () => {
  it("deletes existing case-variant duplicates, keeping the oldest row, then creates the index", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../drizzle/migrations-sqlite");
    const mf = new Miniflare(
      convertV4MiniflareOptions({ modules: true, script: "export default {}", d1Databases: ["DB"] }),
    );
    try {
      const d1 = await mf.getD1Database("DB");
      const apply = async (file: string) => {
        for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
          if (stmt.trim()) await d1.prepare(stmt).run();
        }
      };
      const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      const target = "0003_suppressions_lower_email.sql";
      for (const f of files.filter((f) => f < target)) await apply(f);
      await d1.prepare("INSERT INTO tenants (id, name, slug) VALUES ('t1', 'T1', 't1'), ('t2', 'T2', 't2')").run();
      await d1
        .prepare(
          `INSERT INTO suppressions (id, tenant_id, email, reason, created_at) VALUES
           ('s-new', 't1', 'ann@example.com', 'manual', 3000),
           ('s-old', 't1', 'ANN@example.com', 'manual', 1000),
           ('s-null', 't1', 'Ann@Example.com', 'manual', NULL),
           ('s-t2', 't2', 'ann@example.com', 'manual', 2000),
           ('s-bob', 't1', 'bob@example.com', 'manual', 5000)`,
        )
        .run();
      await apply(target);
      const { results } = await d1.prepare("SELECT id FROM suppressions ORDER BY id").all<{ id: string }>();
      expect(results.map((r) => r.id)).toEqual(["s-bob", "s-old", "s-t2"]);
      await expect(
        d1.prepare("INSERT INTO suppressions (id, tenant_id, email, reason) VALUES ('x', 't1', 'BOB@EXAMPLE.COM', 'manual')").run(),
      ).rejects.toThrow(/UNIQUE/);
    } finally {
      await mf.dispose();
    }
  });
});
