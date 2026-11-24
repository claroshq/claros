#!/usr/bin/env node
/**
 * resubscribe.mjs - Remove a contact from the suppression list.
 *
 * Suppressions are "presence = blocked": deleting the row re-enables sending.
 * This script is intentionally destructive and requires an explicit confirmation.
 *
 * Usage:
 *   # List all suppressed contacts for a tenant and pick one interactively
 *   node scripts/resubscribe.mjs --tenant <slug>
 *
 *   # Resubscribe a specific email directly (with confirmation prompt)
 *   node scripts/resubscribe.mjs --tenant <slug> --email user@example.com
 *
 *   # Skip confirmation prompt
 *   node scripts/resubscribe.mjs --tenant <slug> --email user@example.com --yes
 *
 *   # Target production database
 *   node scripts/resubscribe.mjs --tenant <slug> --email user@example.com --prod
 *
 * Options:
 *   --tenant <slug>    Tenant slug (required)
 *   --email <address>  Email to resubscribe. If omitted, lists suppressions and prompts.
 *   --yes              Skip confirmation prompt.
 *   --prod             Use PRODUCTION_DATABASE_URL instead of DATABASE_URL.
 *   --limit <n>        Max rows to display in list mode (default: 50).
 *
 * Requirements:
 *   - DATABASE_URL (or PRODUCTION_DATABASE_URL with --prod) set in .env or env.
 *   - npm run build must have been run (drizzle/dist/schema/index.js must exist).
 */

import { createInterface } from "node:readline";
import { createReadStream, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Load .env (same no-override parser as migrate.sh and send-test-email.sh)
// ---------------------------------------------------------------------------

const ENV_FILE = resolve(REPO_ROOT, ".env");
if (existsSync(ENV_FILE)) {
  const { readFileSync } = await import("node:fs");
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq);
    let val = trimmed.slice(eq + 1);
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

let tenantSlug = null;
let emailArg = null;
let skipConfirm = false;
let prod = false;
let listLimit = 50;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--tenant":  tenantSlug  = args[++i]; break;
    case "--email":   emailArg    = args[++i]; break;
    case "--yes":     skipConfirm = true;       break;
    case "--prod":    prod        = true;       break;
    case "--limit":   listLimit   = parseInt(args[++i], 10) || 50; break;
    case "-h":
    case "--help":
      console.log([
        "Usage:",
        "  node scripts/resubscribe.mjs --tenant <slug>",
        "  node scripts/resubscribe.mjs --tenant <slug> --email user@example.com",
        "  node scripts/resubscribe.mjs --tenant <slug> --email user@example.com --yes",
        "  node scripts/resubscribe.mjs --tenant <slug> --email user@example.com --prod",
        "",
        "Options:",
        "  --tenant <slug>    Tenant slug (required)",
        "  --email <address>  Email to resubscribe. If omitted, lists suppressions and prompts.",
        "  --yes              Skip confirmation prompt.",
        "  --prod             Use PRODUCTION_DATABASE_URL instead of DATABASE_URL.",
        "  --limit <n>        Max rows to display in list mode (default: 50).",
      ].join("\n"));
      process.exit(0);
    default:
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
  }
}

if (!tenantSlug) {
  console.error("ERROR: --tenant <slug> is required.");
  console.error("Usage: node scripts/resubscribe.mjs --tenant <slug> [--email user@example.com]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Database URL resolution (mirrors migrate.sh / send-test-email.sh)
// ---------------------------------------------------------------------------

let dbUrl;
if (prod) {
  dbUrl = process.env.PRODUCTION_DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: --prod requires PRODUCTION_DATABASE_URL to be set in .env");
    process.exit(1);
  }
} else {
  dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: DATABASE_URL is not set. Set it in .env.");
    process.exit(1);
  }
}

// Guard: reject pooled endpoints
const stripped = dbUrl.replace(/^postgres(?:ql)?:\/\//, "");
const hostDb = stripped.slice(stripped.indexOf("@") + 1);
const hostPort = hostDb.split("/")[0];

if (/-pooler/i.test(hostPort)) {
  console.error("ERROR: URL points to a pooled endpoint. Use the direct endpoint.");
  process.exit(1);
}
if (!prod && /neon\.tech/i.test(hostPort)) {
  console.error("ERROR: DATABASE_URL points to a Neon endpoint but --prod was not passed. Use --prod.");
  process.exit(1);
}

const dbName = (hostDb.split("/")[1] ?? "").split("?")[0] || "(none)";
const dbType = /neon\.tech/i.test(hostPort) ? "Neon (production)"
  : /localhost|127\.0\.0\.|::1/.test(hostPort) ? "local"
  : "remote (unknown)";

// ---------------------------------------------------------------------------
// Check build output
// ---------------------------------------------------------------------------

const schemaDistPath = resolve(REPO_ROOT, "drizzle/dist/schema/index.js");
if (!existsSync(schemaDistPath)) {
  console.error("ERROR: drizzle/dist/schema/index.js not found. Run: npm run build");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------

const pg = await import("pg");
const { drizzle } = await import("drizzle-orm/node-postgres");
const { eq, sql, desc } = await import("drizzle-orm");

const { suppressions, tenants } = await import(schemaDistPath);

const pool = new pg.default.Pool({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });
const db = drizzle(pool);

// ---------------------------------------------------------------------------
// Helper: prompt
// ---------------------------------------------------------------------------

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Look up tenant
// ---------------------------------------------------------------------------

console.log("");
console.log("=== Claros Resubscribe ===");
console.log("");
console.log(`Database: ${hostPort}/${dbName} [${dbType}]`);
if (prod) console.log("Mode:     PRODUCTION (--prod)");
console.log(`Tenant:   ${tenantSlug}`);
console.log("");

const tenantRows = await db
  .select({ id: tenants.id, name: tenants.name })
  .from(tenants)
  .where(eq(tenants.slug, tenantSlug))
  .limit(1);

if (tenantRows.length === 0) {
  console.error(`ERROR: Tenant with slug "${tenantSlug}" not found.`);
  await pool.end();
  process.exit(1);
}

const tenant = tenantRows[0];
console.log(`Tenant: ${tenant.name} (${tenant.id})`);
console.log("");

// ---------------------------------------------------------------------------
// If no --email: list suppressions and let user pick
// ---------------------------------------------------------------------------

let targetEmail = emailArg;

if (!targetEmail) {
  // List suppressed contacts
  const rows = await db
    .select({
      id: suppressions.id,
      email: suppressions.email,
      reason: suppressions.reason,
      source: suppressions.source,
      createdAt: suppressions.createdAt,
    })
    .from(suppressions)
    .where(eq(suppressions.tenantId, tenant.id))
    .orderBy(desc(suppressions.createdAt))
    .limit(listLimit);

  if (rows.length === 0) {
    console.log("No suppressed contacts found for this tenant.");
    await pool.end();
    process.exit(0);
  }

  console.log(`Suppressed contacts (${rows.length}${rows.length === listLimit ? `, showing first ${listLimit}` : ""}):`);
  console.log("");

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad("#", 4)} ${pad("Email", 40)} ${pad("Reason", 14)} ${pad("Source", 12)} Suppressed at`);
  console.log(`  ${"-".repeat(4)} ${"-".repeat(40)} ${"-".repeat(14)} ${"-".repeat(12)} ${"-".repeat(24)}`);

  rows.forEach((r, i) => {
    const date = r.createdAt ? new Date(r.createdAt).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "-";
    console.log(`  ${pad(i + 1, 4)} ${pad(r.email, 40)} ${pad(r.reason, 14)} ${pad(r.source ?? "-", 12)} ${date}`);
  });

  console.log("");
  const answer = await prompt("Enter number or email address to resubscribe (or blank to cancel): ");

  if (!answer) {
    console.log("Cancelled. Nothing changed.");
    await pool.end();
    process.exit(0);
  }

  const num = parseInt(answer, 10);
  if (!isNaN(num) && num >= 1 && num <= rows.length) {
    targetEmail = rows[num - 1].email;
  } else if (answer.includes("@")) {
    targetEmail = answer;
  } else {
    console.error("Invalid input. Enter a number from the list or an email address.");
    await pool.end();
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Look up the suppression row for the target email
// ---------------------------------------------------------------------------

const suppRows = await db
  .select({
    id: suppressions.id,
    email: suppressions.email,
    reason: suppressions.reason,
    source: suppressions.source,
    createdAt: suppressions.createdAt,
  })
  .from(suppressions)
  .where(
    sql`${suppressions.tenantId} = ${tenant.id}
      AND lower(${suppressions.email}) = lower(${targetEmail})`
  )
  .limit(1);

if (suppRows.length === 0) {
  console.log(`No suppression found for "${targetEmail}" under tenant "${tenantSlug}".`);
  console.log("Nothing to do - contact is not suppressed.");
  await pool.end();
  process.exit(0);
}

const supp = suppRows[0];
const suppressedAt = supp.createdAt
  ? new Date(supp.createdAt).toISOString().replace("T", " ").slice(0, 19) + " UTC"
  : "-";

console.log("Suppression found:");
console.log(`  Email:       ${supp.email}`);
console.log(`  Reason:      ${supp.reason}`);
console.log(`  Source:      ${supp.source ?? "-"}`);
console.log(`  Suppressed:  ${suppressedAt}`);
console.log(`  ID:          ${supp.id}`);
console.log("");

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

if (!skipConfirm) {
  const confirm = await prompt(`Remove suppression for "${supp.email}"? Type "yes" to confirm: `);
  if (confirm !== "yes") {
    console.log("");
    console.log("Aborted. Nothing changed.");
    await pool.end();
    process.exit(0);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Delete suppression
// ---------------------------------------------------------------------------

await db.delete(suppressions).where(eq(suppressions.id, supp.id));

console.log(`Suppression removed for "${supp.email}".`);
console.log(`The contact can now receive emails again (suppression layer cleared).`);
console.log("");
console.log("NOTE: This only removes the suppression record. It does not re-enroll");
console.log("the contact in any flows. Sending resumes naturally on next flow execution.");

await pool.end();
