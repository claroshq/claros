/**
 * Migration 0023_instance_layer (multi-product, expand step) on an install
 * with existing data.
 *
 * Builds a throwaway database next to DATABASE_URL, applies every migration
 * before 0023, inserts v0.6/v0.7-shaped data (two tenants, owners, members,
 * a deactivated owner, an API key), applies 0023, and checks the backfill:
 *   - one membership row per existing user, with the user's role
 *   - instance_role = 'admin' for the active owners of the oldest tenant only
 *   - new tenant columns have their defaults; existing API keys are unchanged
 *
 * The v0.6.4 dump is covered by scripts/test-upgrade.sh, which checks the
 * same backfill invariants on real upgraded data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("[instance-migration.test] DATABASE_URL is not set (see .env.example).");
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "drizzle", "migrations");
const TARGET = "0023_instance_layer";
const DB_NAME = `claros_instance_mig_${process.pid}_${Date.now()}`;

function urlFor(dbName: string): string {
  const u = new URL(DATABASE_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function applyMigration(client: pg.Client, tag: string): Promise<void> {
  const sqlText = readFileSync(join(migrationsDir, `${tag}.sql`), "utf-8");
  for (const statement of sqlText.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.query(statement);
  }
}

let admin: pg.Client;
let client: pg.Client;
const t: Record<string, string> = {};
const u: Record<string, string> = {};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  client = new pg.Client({ connectionString: urlFor(DB_NAME) });
  await client.connect();

  const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf-8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const tags = journal.entries.sort((a, b) => a.idx - b.idx).map((e) => e.tag);
  const targetIdx = tags.indexOf(TARGET);
  expect(targetIdx).toBeGreaterThan(0);
  for (const tag of tags.slice(0, targetIdx)) await applyMigration(client, tag);

  // Existing data: "old" is the oldest tenant, "young" a later one.
  const ins = async (q: string, params: unknown[]) => (await client.query<{ id: string }>(q, params)).rows[0]!.id;
  t.old = await ins(`INSERT INTO tenants (name, slug, created_at) VALUES ('Old', 'old', now() - interval '30 days') RETURNING id`, []);
  t.young = await ins(`INSERT INTO tenants (name, slug, created_at) VALUES ('Young', 'young', now()) RETURNING id`, []);
  const user = (tenant: string, email: string, role: string, deactivated = false) =>
    ins(
      `INSERT INTO users (tenant_id, email, role, deactivated_at) VALUES ($1, $2, $3, ${deactivated ? "now()" : "NULL"}) RETURNING id`,
      [tenant, email, role],
    );
  u.oldOwner = await user(t.old!, "owner@old.test", "owner");
  u.oldOwner2 = await user(t.old!, "owner2@old.test", "owner");
  u.oldMember = await user(t.old!, "member@old.test", "member");
  u.oldGone = await user(t.old!, "gone@old.test", "owner", true);
  u.youngOwner = await user(t.young!, "owner@young.test", "owner");
  await client.query(`INSERT INTO api_keys (tenant_id, key_hash, prefix, kind) VALUES ($1, 'h1', 'cl_live_', 'secret')`, [t.old]);

  await applyMigration(client, TARGET);
}, 120_000);

afterAll(async () => {
  await client?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.end();
  }
});

describe(`migration ${TARGET}`, () => {
  it("backfills one membership per existing user with the user's role", async () => {
    const { rows } = await client.query<{ user_id: string; tenant_id: string; role: string }>(
      "SELECT user_id, tenant_id, role FROM memberships ORDER BY role, user_id",
    );
    expect(rows).toHaveLength(5);
    const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r]));
    expect(byUser[u.oldOwner!]).toMatchObject({ tenant_id: t.old, role: "owner" });
    expect(byUser[u.oldMember!]).toMatchObject({ tenant_id: t.old, role: "member" });
    expect(byUser[u.oldGone!]).toMatchObject({ tenant_id: t.old, role: "owner" });
    expect(byUser[u.youngOwner!]).toMatchObject({ tenant_id: t.young, role: "owner" });
  });

  it("makes the active owners of the oldest tenant instance admins, nobody else", async () => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE instance_role = 'admin' ORDER BY id",
    );
    expect(rows.map((r) => r.id).sort()).toEqual([u.oldOwner!, u.oldOwner2!].sort());
  });

  it("adds tenant columns with their defaults", async () => {
    const { rows } = await client.query(
      "SELECT archived_at, public_host, locale, config_version FROM tenants ORDER BY created_at",
    );
    expect(rows).toEqual([
      { archived_at: null, public_host: null, locale: null, config_version: 0 },
      { archived_at: null, public_host: null, locale: null, config_version: 0 },
    ]);
  });

  it("keeps existing API keys and allows instance keys without a tenant", async () => {
    const { rows } = await client.query("SELECT tenant_id, kind FROM api_keys");
    expect(rows).toEqual([{ tenant_id: t.old, kind: "secret" }]);
    await client.query(`INSERT INTO api_keys (tenant_id, key_hash, prefix, kind) VALUES (NULL, 'h2', 'cl_inst_', 'instance')`);
  });

  it("enforces a unique public host and one membership per user and tenant", async () => {
    await client.query("UPDATE tenants SET public_host = 'a.example.com' WHERE slug = 'old'");
    await expect(
      client.query("UPDATE tenants SET public_host = 'a.example.com' WHERE slug = 'young'"),
    ).rejects.toThrow(/uq_tenants_public_host/);
    await expect(
      client.query("INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'member')", [u.oldOwner, t.old]),
    ).rejects.toThrow(/memberships_pkey/);
  });

  it("deletes memberships with their user", async () => {
    await client.query("DELETE FROM users WHERE id = $1", [u.oldMember]);
    const { rows } = await client.query("SELECT 1 FROM memberships WHERE user_id = $1", [u.oldMember]);
    expect(rows).toHaveLength(0);
  });
});
