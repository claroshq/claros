#!/usr/bin/env node
/**
 * Generate an API write key for a tenant.
 *
 * Usage:
 *   node scripts/generate-api-key.mjs <tenant_slug> [label]
 *
 * Requires DATABASE_URL pointing at local Postgres.
 * Prints the raw key ONCE to stdout - it cannot be retrieved later.
 *
 * Example:
 *   node scripts/generate-api-key.mjs my-company "Production backend"
 *   # Output: cl_live_aBcDeFgH...  (the full raw key)
 */
import { randomBytes, createHash } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { tenants, apiKeys } from "@claros/db/schema";

const slug = process.argv[2];
const label = process.argv[3] ?? null;

if (!slug) {
  console.error("Usage: node scripts/generate-api-key.mjs <tenant_slug> [label]");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Error: DATABASE_URL must be set.");
  process.exit(1);
}

const pool = new pg.default.Pool({ connectionString: url });
const db = drizzle(pool);

// Find tenant by slug
const rows = await db
  .select({ id: tenants.id, name: tenants.name })
  .from(tenants)
  .where(eq(tenants.slug, slug))
  .limit(1);

if (rows.length === 0) {
  console.error(`Error: tenant with slug "${slug}" not found.`);
  await pool.end();
  process.exit(1);
}

const tenant = rows[0];

// Generate the raw key: "cl_live_" prefix + 32 random bytes (base64url)
const randomPart = randomBytes(32).toString("base64url");
const rawKey = `cl_live_${randomPart}`;
const prefix = rawKey.slice(0, 8); // "cl_live_"
const keyHash = createHash("sha256").update(rawKey).digest("hex");

// Insert the key
await db.insert(apiKeys).values({
  tenantId: tenant.id,
  keyHash,
  prefix,
  label,
});

console.log(`\nAPI key created for tenant "${tenant.name}" (${slug}):`);
console.log(`\n  ${rawKey}\n`);
console.log("Save this key now - it cannot be retrieved later.");
console.log(`Prefix for identification: ${prefix}...`);
if (label) console.log(`Label: ${label}`);

await pool.end();
