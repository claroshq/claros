#!/usr/bin/env node
/**
 * claros - Operator CLI for the Claros lifecycle email engine.
 *
 * One CLI for every operator task: login links, credential setup, and
 * guided first-run configuration.
 *
 * Usage (local checkout, after npm run build):
 *   node apps/server/bin/claros.mjs <command> [options]
 *
 * Usage (Docker Compose, app container running):
 *   docker compose exec app claros <command> [options]
 *
 * Commands:
 *   doctor [--url <url>] [--session <token>]   Read-only deployment diagnostic
 *   login-link <email>               Generate a one-time login URL (no transport required)
 *   setup [tenant_slug]              Guided first-run: postal address, LLM, transport
 *   transport set <tenant_slug>      Write transport credentials
 *   transport show <tenant_slug>     Show active transport config (no credentials)
 *   llm set <tenant_slug>            Write LLM credentials
 *   llm show <tenant_slug>           Show active LLM config (no credentials)
 *   postal-address set <slug>        Set the CAN-SPAM postal address
 *   postal-address show <slug>       Show the current postal address
 *   help [command]                   Show help for a command
 *
 * Options:
 *   --prod   Target PRODUCTION_DATABASE_URL instead of DATABASE_URL (local).
 *            Requires typed confirmation before any write in interactive mode.
 *            Production writes in non-interactive mode are confirmed by the flag itself.
 *
 * Prerequisites:
 *   Run `npm run build` once first. This script imports from built dist/ directories:
 *     packages/adapters/dist/  (crypto)
 *     drizzle/dist/            (@claros/db schema)
 *
 * [impl] Shared write path:
 *   transport set / llm set: use encrypt() + parseEncryptionKey() from
 *     packages/adapters/src/crypto.ts, the same functions as PUT /v1/settings/transport
 *     and PUT /v1/settings/llm in packages/api/src/routes/settings.ts.
 *   postal-address set: read-modify-write on tenants.settings JSONB, the same
 *     pattern as PATCH /v1/settings/tenant (packages/api/src/routes/settings.ts:582-600).
 *   login-link: uses generateToken() + magicLinkTokens table, the same logic as
 *     POST /auth/login in packages/api/src/routes/auth.ts. No HTTP server required.
 */
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, statSync, chownSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and, sql, isNull } from "drizzle-orm";

// Resolve repo root (apps/server/bin -> apps/server -> apps -> repo root)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Comparison logic extracted for testability (see doctor-compare.mjs).
const { compareCommits, compareKeyFingerprints, formatCommitVerdict, formatKeyVerdict } = await import(
  resolve(dirname(fileURLToPath(import.meta.url)), "doctor-compare.mjs")
);

// ---------------------------------------------------------------------------
// Argument parsing (runs before dist imports so `install` can early-exit)
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isProd = args.includes("--prod");
const filteredArgs = args.filter((a) => a !== "--prod");

const [topCommand, ...restArgs] = filteredArgs;

// ---------------------------------------------------------------------------
// claros install - early exit, runs before .env exists
// ---------------------------------------------------------------------------

if (topCommand === "install") {
  await cmdInstall(restArgs);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Import from built dist directories (run `npm run build` first).
// These are deferred to after the install early-exit because install does
// not need compiled packages and must work before `npm run build` has run
// (e.g. inside a fresh Docker image where dist is available from the builder
// stage, but not on the host before the first build).
// ---------------------------------------------------------------------------
const { encrypt, decrypt, parseEncryptionKey } = await import(
  resolve(repoRoot, "packages/adapters/dist/index.js")
);
const {
  tenants,
  transportConfigs,
  llmConfigs,
  users,
  magicLinkTokens,
  memberships,
} = await import(resolve(repoRoot, "drizzle/dist/schema/index.js"));

// ---------------------------------------------------------------------------
// .env loading (line-by-line, no shell eval, no override of existing env vars)
// Mirrors the loader in scripts/migrate.sh
// ---------------------------------------------------------------------------

const envFile = resolve(repoRoot, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eqIdx + 1);
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Database URL resolution (mirrors scripts/migrate.sh conventions)
// ---------------------------------------------------------------------------

function parseDbTarget(url) {
  const stripped = url.replace(/^postgres(?:ql)?:\/\//, "");
  const hostDb = stripped.replace(/^[^@]*@/, "");
  const hostPort = hostDb.split("/")[0] ?? "";
  const dbAndParams = hostDb.split("/")[1] ?? "";
  const dbName = dbAndParams.split("?")[0] || "(none)";

  let type;
  if (/neon\.tech/i.test(hostPort)) {
    type = "Neon (production)";
  } else if (/localhost|127\.0\.0\.|::1/.test(hostPort)) {
    type = "local";
  } else {
    type = "remote (unknown)";
  }

  if (!isProd && /neon\.tech/i.test(hostPort)) {
    console.error("\nERROR: DATABASE_URL points to a Neon endpoint but --prod was not passed.");
    console.error(`  Host: ${hostPort}`);
    console.error("Use --prod to target production.\n");
    process.exit(1);
  }

  if (/-pooler/i.test(hostPort)) {
    console.error("\nERROR: Target URL points to a pooled endpoint. Use the direct endpoint.\n");
    process.exit(1);
  }

  return { hostPort, dbName, type };
}

function resolveDbUrl() {
  if (isProd) {
    const url = process.env.PRODUCTION_DATABASE_URL;
    if (!url) {
      console.error("\nERROR: --prod requires PRODUCTION_DATABASE_URL to be set.\n");
      process.exit(1);
    }
    return url;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("\nERROR: DATABASE_URL is not set. Set it in .env.\n");
    process.exit(1);
  }
  return url;
}

// ---------------------------------------------------------------------------
// TTY detection
// ---------------------------------------------------------------------------
//
// process.stdin.isTTY is true on a real terminal, undefined/false on a pipe.
//
// CLAROS_SETTINGS_INTERACTIVE=1 forces interactive mode for tests that pipe
// scripted input but need to exercise the prompts path.

const isInteractive = !!process.stdin.isTTY || process.env.CLAROS_SETTINGS_INTERACTIVE === "1";

// ---------------------------------------------------------------------------
// Line queue for interactive reading
// ---------------------------------------------------------------------------
//
// When input is piped, all lines arrive buffered. A queue serializes sequential
// readLine calls so each call gets exactly one line in arrival order regardless
// of how many lines arrived simultaneously.

const _lineQueue = [];
const _lineReaders = [];
let _lineRlClosed = false;
let _lineRl = null;

function ensureLineRl() {
  if (_lineRl) return;
  _lineRl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  _lineRl.on("line", (line) => {
    if (_lineReaders.length > 0) {
      _lineReaders.shift()(line);
    } else {
      _lineQueue.push(line);
    }
  });
  _lineRl.on("close", () => {
    _lineRlClosed = true;
    while (_lineReaders.length > 0) _lineReaders.shift()("");
  });
}

function closeLineRl() {
  if (_lineRl) { _lineRl.close(); _lineRl = null; }
}

function readLineInteractive(prompt) {
  ensureLineRl();
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    if (_lineQueue.length > 0) {
      resolve(_lineQueue.shift());
    } else if (_lineRlClosed) {
      resolve("");
    } else {
      _lineReaders.push(resolve);
    }
  });
}

/**
 * Read a secret without echoing.
 * On a real TTY: uses raw mode to suppress echo.
 * On a pipe (CLAROS_SETTINGS_INTERACTIVE=1): reads a normal line.
 *
 * Secret fields: api_key (transport and LLM), webhook_secret (transport).
 * None appear in stdout, stderr, or the pre-write summary; only presence
 * and character count are shown.
 */
function readSecretInteractive(prompt) {
  if (process.stdin.isTTY) {
    return new Promise((resolve) => {
      process.stdout.write(prompt);
      closeLineRl();
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      let value = "";
      const onData = (char) => {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          _lineRlClosed = false;
          resolve(value);
        } else if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " ") {
          value += char;
        }
      };
      process.stdin.on("data", onData);
    });
  }
  return readLineInteractive(prompt);
}

async function readStdinJson() {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    const lines = [];
    rl.on("line", (line) => lines.push(line));
    rl.on("close", () => {
      const raw = lines.join("\n").trim();
      if (!raw) {
        reject(new Error("No input received. Pipe JSON to stdin or run interactively."));
        return;
      }
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error(`Invalid JSON: ${raw.slice(0, 200)}`)); }
    });
    rl.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

/**
 * Prompt for a single field interactively.
 * Required fields re-prompt on empty input. Optional fields accept Enter for
 * the default. Secret fields are read without echoing.
 */
async function promptField(opts) {
  const { name, description, required, defaultValue, allowed, secret, validate } = opts;
  while (true) {
    const parts = [];
    if (description) parts.push(description);
    if (allowed && allowed.length > 0) parts.push(`Allowed: ${allowed.join(", ")}`);
    if (!required) {
      if (defaultValue !== undefined && defaultValue !== null && defaultValue !== "") {
        parts.push(`Default: ${defaultValue}`);
      } else {
        parts.push("Optional, press Enter to skip");
      }
    } else {
      parts.push("Required");
    }
    const prompt = `  ${name} (${parts.join(". ")}): `;

    let answer;
    if (secret) {
      answer = await readSecretInteractive(prompt);
      process.stdout.write("\n");
    } else {
      answer = await readLineInteractive(prompt);
    }
    answer = answer.trim();

    if (answer === "") {
      if (defaultValue !== undefined && defaultValue !== null && defaultValue !== "") {
        return String(defaultValue);
      }
      if (!required) return "";
      console.error(`  ERROR: ${name} is required. Please enter a value.`);
      continue;
    }
    if (allowed && allowed.length > 0 && !allowed.includes(answer)) {
      console.error(`  ERROR: "${answer}" is not valid. Allowed: ${allowed.join(", ")}`);
      continue;
    }
    if (validate) {
      const err = validate(answer);
      if (err) { console.error(`  ERROR: ${err}`); continue; }
    }
    return answer;
  }
}

async function confirmProduction(hostPort, dbName) {
  if (!isInteractive) return true;
  const answer = await readLineInteractive(
    `\nWrite to PRODUCTION (${hostPort}/${dbName})? Type "yes" to confirm: `,
  );
  return answer.trim().toLowerCase() === "yes";
}

async function confirmWrite(summaryLines) {
  console.log("\n--- Summary: what will be stored ---\n");
  for (const line of summaryLines) console.log(`  ${line}`);
  console.log("");
  if (!isInteractive) return true;
  const answer = await readLineInteractive("Write this configuration? [y/N] ");
  const yes = answer.trim().toLowerCase();
  return yes === "y" || yes === "yes";
}

// ---------------------------------------------------------------------------
// Tenant lookup
// ---------------------------------------------------------------------------

async function findTenant(db, slug) {
  const rows = await db
    .select({ id: tenants.id, name: tenants.name, settings: tenants.settings })
    .from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (rows.length === 0) {
    console.error(`\nERROR: Tenant "${slug}" not found.\n`);
    process.exit(1);
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// ENCRYPTION_KEY
// ---------------------------------------------------------------------------

function resolveEncryptionKey() {
  const keyEnv = process.env.ENCRYPTION_KEY;
  if (!keyEnv) {
    console.error("\nERROR: ENCRYPTION_KEY is not set. Set it in .env.\n");
    process.exit(1);
  }
  try { return parseEncryptionKey(keyEnv); }
  catch (err) {
    console.error(`\nERROR: ENCRYPTION_KEY is invalid: ${err.message}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Known providers
// ---------------------------------------------------------------------------

const KNOWN_TRANSPORT_PROVIDERS = ["resend", "smtp"];
const KNOWN_LLM_PROVIDERS = ["openai", "anthropic", "ollama", "custom"];

/**
 * Default base_url for known LLM providers.
 * custom has no sensible default - operator must supply it.
 */
const LLM_DEFAULT_BASE_URL = {
  openai:    "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  ollama:    "http://localhost:11434/v1",
  custom:    null,
};

function validateEmail(value) {
  if (!value.includes("@")) return "Must be a valid email address (missing @)";
  const [local, domain] = value.split("@");
  if (!local || local.length === 0) return "Must be a valid email address (empty local part)";
  if (!domain || !domain.includes(".")) return "Must be a valid email address (domain must contain a dot)";
  return null;
}

// ---------------------------------------------------------------------------
// login-link
//
// Generates a one-time magic link login URL without requiring a running server
// or a configured email transport. Writes a token to the DB and prints the URL.
//
// [impl] Same logic as POST /auth/login in packages/api/src/routes/auth.ts:
// - randomBytes(32) token, SHA-256 hash stored in magic_link_tokens
// - 10-minute TTL
// - URL: DASHBOARD_URL ?? BASE_URL ?? http://localhost:3000 + /auth/verify?token=<raw>
// ---------------------------------------------------------------------------

async function cmdLoginLink(db, email) {
  const normalized = email.toLowerCase().trim();

  const userRows = await db
    .select({ id: users.id, tenantId: users.tenantId, email: users.email })
    .from(users).where(eq(users.email, normalized)).limit(1);

  if (userRows.length === 0) {
    console.error(`\nERROR: No user with email "${normalized}" found in the database.`);
    console.error("If this is a fresh install, ensure SEED_ADMIN_EMAIL is set and the server has run once.\n");
    process.exit(1);
  }

  const user = userRows[0];
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  const TTL_MINUTES = 10;
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);

  await db.insert(magicLinkTokens).values({
    tenantId: user.tenantId,
    userId: user.id,
    tokenHash: hash,
    expiresAt,
  });

  // Resolution order: DASHBOARD_URL, then BASE_URL, then http://localhost:3000.
  // Matches the resolution chain in packages/api/src/app.ts (dashboardUrl).
  // In Vite dev mode set DASHBOARD_URL=http://localhost:5173 so the printed
  // link is directly clickable in a browser (Vite proxy forwards /auth/* to Fastify).
  const linkBase = (
    process.env.DASHBOARD_URL ?? process.env.BASE_URL ?? "http://localhost:3000"
  ).replace(/\/$/, "");
  const loginUrl = `${linkBase}/auth/verify?token=${raw}`;

  console.log("");
  console.log("========================================");
  console.log("  CLAROS LOGIN LINK");
  console.log("========================================");
  console.log(`  Email:   ${normalized}`);
  console.log(`  URL:     ${loginUrl}`);
  console.log(`  Expires: ${TTL_MINUTES} minutes`);
  console.log("========================================");
  console.log("");
  console.log("Open the URL in a browser. It is single-use and expires in 10 minutes.");
  console.log("");
}

// ---------------------------------------------------------------------------
// transport set
// ---------------------------------------------------------------------------

async function transportSet(db, tenantSlug, dbInfo) {
  const tenant = await findTenant(db, tenantSlug);
  console.log(`\nTenant: ${tenant.name} (${tenantSlug})`);
  console.log(`Target: ${dbInfo.hostPort}/${dbInfo.dbName} [${dbInfo.type}]`);
  let payload;
  if (isInteractive) {
    console.log("\nEnter transport configuration. Required fields are marked Required.");
    console.log("Secret fields will not be echoed.\n");

    const provider = await promptField({
      name: "provider", description: "Email provider", required: true,
      allowed: KNOWN_TRANSPORT_PROVIDERS,
    });
    const from_email = await promptField({
      name: "from_email", description: "Sender address (From: header)", required: true,
      validate: validateEmail,
    });
    const from_name = await promptField({
      name: "from_name", description: "Sender display name", required: false,
    });
    const daily_limit_str = await promptField({
      name: "daily_limit", description: "Maximum emails per day (blank = provider default)",
      required: false,
    });

    if (provider === "smtp") {
      const host = await promptField({
        name: "host", description: "SMTP server hostname", required: true,
      });
      const port_str = await promptField({
        name: "port", description: "SMTP port (465=TLS, 587=STARTTLS, 25=plain)", required: true,
      });
      const username = await promptField({
        name: "username", description: "SMTP username (blank for unauthenticated relay)", required: false,
      });
      const password = await promptField({
        name: "password", description: "SMTP password", required: false, secret: true,
      });
      payload = {
        provider, from_email,
        from_name: from_name || undefined,
        host,
        port: parseInt(port_str, 10),
        secure: parseInt(port_str, 10) === 465,
        username: username || undefined,
        password: password || undefined,
        daily_limit: daily_limit_str ? parseInt(daily_limit_str, 10) : undefined,
      };
    } else {
      const api_key = await promptField({
        name: "api_key", description: "Provider API key", required: true, secret: true,
      });
      const webhook_secret = await promptField({
        name: "webhook_secret", description: "Webhook signing secret (for event verification)",
        required: false, secret: true,
      });
      payload = {
        provider, from_email,
        from_name: from_name || undefined,
        api_key,
        webhook_secret: webhook_secret || undefined,
        daily_limit: daily_limit_str ? parseInt(daily_limit_str, 10) : undefined,
      };
    }
  } else {
    try { payload = await readStdinJson(); }
    catch (err) { console.error(`\nERROR: ${err.message}\n`); process.exit(1); }
  }

  const { provider, from_email, from_name, daily_limit } = payload;

  if (!provider || !from_email) {
    console.error("\nERROR: Required fields: provider, from_email\n"); process.exit(1);
  }
  if (provider === "resend" && !payload.api_key) {
    console.error("\nERROR: api_key is required for Resend\n"); process.exit(1);
  }
  if (provider === "smtp" && (!payload.host || !payload.port)) {
    console.error("\nERROR: host and port are required for SMTP\n"); process.exit(1);
  }
  if (!KNOWN_TRANSPORT_PROVIDERS.includes(provider)) {
    console.error(`\nERROR: Unknown provider "${provider}". Valid: ${KNOWN_TRANSPORT_PROVIDERS.join(", ")}\n`);
    process.exit(1);
  }
  const emailErr = validateEmail(from_email);
  if (emailErr) {
    console.error(`\nERROR: from_email: ${emailErr}\n`); process.exit(1);
  }

  if (isProd) {
    const confirmed = await confirmProduction(dbInfo.hostPort, dbInfo.dbName);
    if (!confirmed) { console.log("\nAborted.\n"); process.exit(0); }
  }

  let summaryLines;
  if (provider === "smtp") {
    summaryLines = [
      `Tenant:          ${tenant.name} (${tenantSlug})`,
      `Database:        ${dbInfo.hostPort}/${dbInfo.dbName} [${dbInfo.type}]`,
      `provider:        ${provider}`,
      `from_email:      ${from_email}`,
      `from_name:       ${from_name || "(not set)"}`,
      `host:            ${payload.host}`,
      `port:            ${payload.port}`,
      `secure:          ${payload.secure}`,
      `username:        ${payload.username || "(not set)"}`,
      `password:        ${payload.password ? `(present, ${payload.password.length} chars)` : "(not set)"}`,
      `daily_limit:     ${daily_limit ?? "(not set)"}`,
    ];
  } else {
    summaryLines = [
      `Tenant:          ${tenant.name} (${tenantSlug})`,
      `Database:        ${dbInfo.hostPort}/${dbInfo.dbName} [${dbInfo.type}]`,
      `provider:        ${provider}`,
      `from_email:      ${from_email}`,
      `from_name:       ${from_name || "(not set)"}`,
      `api_key:         (present, ${payload.api_key.length} chars)`,
      `webhook_secret:  ${payload.webhook_secret ? `(present, ${payload.webhook_secret.length} chars)` : "(not set)"}`,
      `daily_limit:     ${daily_limit ?? "(not set)"}`,
    ];
  }
  if (isProd) summaryLines.push("Mode:            PRODUCTION (--prod)");

  const ok = await confirmWrite(summaryLines);
  if (!ok) { console.log("\nAborted.\n"); process.exit(0); }

  const key = resolveEncryptionKey();
  let credentials;
  if (provider === "smtp") {
    credentials = {
      host: payload.host,
      port: payload.port,
      secure: payload.secure,
      username: payload.username,
      password: payload.password,
      rejectUnauthorized: true,
    };
  } else {
    credentials = { apiKey: payload.api_key };
    if (payload.webhook_secret) credentials.webhookSecret = payload.webhook_secret;
  }
  const encryptedConfig = encrypt(JSON.stringify(credentials), key);

  await db.update(transportConfigs).set({ isActive: false })
    .where(and(eq(transportConfigs.tenantId, tenant.id), eq(transportConfigs.isActive, true)));

  const [inserted] = await db.insert(transportConfigs).values({
    tenantId: tenant.id, provider,
    config: sql`${encryptedConfig}::jsonb`,
    isActive: true, fromEmail: from_email,
    fromName: from_name ?? null, dailyLimit: daily_limit ?? null,
  }).returning({
    id: transportConfigs.id,
    provider: transportConfigs.provider,
    fromEmail: transportConfigs.fromEmail,
    createdAt: transportConfigs.createdAt,
  });

  console.log("\nTransport configuration written.");
  console.log(`  id:         ${inserted.id}`);
  console.log(`  provider:   ${inserted.provider}`);
  console.log(`  from_email: ${inserted.fromEmail}`);
  console.log(`  created_at: ${inserted.createdAt}`);
  console.log("  api_key:    (stored encrypted)\n");
}

// ---------------------------------------------------------------------------
// transport show
// ---------------------------------------------------------------------------

async function transportShow(db, tenantSlug) {
  const tenant = await findTenant(db, tenantSlug);
  const rows = await db.select({
    id: transportConfigs.id, provider: transportConfigs.provider,
    fromEmail: transportConfigs.fromEmail, fromName: transportConfigs.fromName,
    dailyLimit: transportConfigs.dailyLimit, dkimVerified: transportConfigs.dkimVerified,
    isActive: transportConfigs.isActive, createdAt: transportConfigs.createdAt,
  }).from(transportConfigs)
    .where(and(eq(transportConfigs.tenantId, tenant.id), eq(transportConfigs.isActive, true)))
    .limit(1);

  if (rows.length === 0) {
    console.log(`\nNo active transport configuration for tenant "${tenantSlug}".\n`); return;
  }
  const row = rows[0];
  console.log(`\nActive transport for "${tenant.name}" (${tenantSlug}):`);
  console.log(`  id:            ${row.id}`);
  console.log(`  provider:      ${row.provider}`);
  console.log(`  from_email:    ${row.fromEmail}`);
  console.log(`  from_name:     ${row.fromName ?? "(not set)"}`);
  console.log(`  daily_limit:   ${row.dailyLimit ?? "(not set)"}`);
  console.log(`  dkim_verified: ${row.dkimVerified}`);
  console.log(`  is_active:     ${row.isActive}`);
  console.log(`  created_at:    ${row.createdAt}`);
  console.log("  api_key:       (stored encrypted - not shown)\n");
}

// ---------------------------------------------------------------------------
// llm set
// ---------------------------------------------------------------------------

async function llmSet(db, tenantSlug, dbInfo) {
  const tenant = await findTenant(db, tenantSlug);
  console.log(`\nTenant: ${tenant.name} (${tenantSlug})`);
  console.log(`Target: ${dbInfo.hostPort}/${dbInfo.dbName} [${dbInfo.type}]`);

  let payload;
  if (isInteractive) {
    console.log("\nEnter LLM configuration. Required fields are marked Required.");
    console.log("The api_key will not be echoed.\n");
    const provider = await promptField({
      name: "provider", description: "LLM provider", required: true,
      allowed: KNOWN_LLM_PROVIDERS,
    });
    const api_key = await promptField({
      name: "api_key", description: "Provider API key", required: true, secret: true,
    });
    const defaultBaseUrl = LLM_DEFAULT_BASE_URL[provider] ?? null;
    const base_url = await promptField({
      name: "base_url", description: "OpenAI-compatible API base URL",
      required: defaultBaseUrl === null, // required only for custom
      defaultValue: defaultBaseUrl,
    });
    const model = await promptField({
      name: "model", description: "Model identifier (e.g. gpt-4o, claude-3-5-sonnet-20241022)",
      required: true,
    });
    const embedding_model = await promptField({
      name: "embedding_model", description: "Embedding model (must produce vector(1536))",
      required: false, defaultValue: "text-embedding-3-small",
    });
    payload = {
      provider, api_key, base_url, model,
      embedding_model: embedding_model || undefined,
    };
  } else {
    try { payload = await readStdinJson(); }
    catch (err) { console.error(`\nERROR: ${err.message}\n`); process.exit(1); }
  }

  const { provider, api_key, model, embedding_model } = payload;
  // Apply per-provider base_url default when the caller omitted it.
  const base_url = payload.base_url || LLM_DEFAULT_BASE_URL[provider] || null;

  if (!provider || !api_key || !base_url || !model) {
    console.error("\nERROR: Required fields: provider, api_key, model (base_url defaults for openai/anthropic/ollama)\n"); process.exit(1);
  }
  if (!KNOWN_LLM_PROVIDERS.includes(provider)) {
    console.error(`\nERROR: Unknown provider "${provider}". Valid: ${KNOWN_LLM_PROVIDERS.join(", ")}\n`);
    process.exit(1);
  }

  if (isProd) {
    const confirmed = await confirmProduction(dbInfo.hostPort, dbInfo.dbName);
    if (!confirmed) { console.log("\nAborted.\n"); process.exit(0); }
  }

  const summaryLines = [
    `Tenant:          ${tenant.name} (${tenantSlug})`,
    `Database:        ${dbInfo.hostPort}/${dbInfo.dbName} [${dbInfo.type}]`,
    `provider:        ${provider}`,
    `api_key:         (present, ${api_key.length} chars)`,
    `base_url:        ${base_url}`,
    `model:           ${model}`,
    `embedding_model: ${embedding_model || "(default: text-embedding-3-small)"}`,
  ];
  if (isProd) summaryLines.push("Mode:            PRODUCTION (--prod)");

  const ok = await confirmWrite(summaryLines);
  if (!ok) { console.log("\nAborted.\n"); process.exit(0); }

  const key = resolveEncryptionKey();
  const credentials = { apiKey: api_key, baseUrl: base_url, model };
  if (embedding_model) credentials.embedding_model = embedding_model;
  const encryptedConfig = encrypt(JSON.stringify(credentials), key);

  await db.update(llmConfigs).set({ isActive: false })
    .where(and(eq(llmConfigs.tenantId, tenant.id), eq(llmConfigs.isActive, true)));

  const [inserted] = await db.insert(llmConfigs).values({
    tenantId: tenant.id, provider, config: encryptedConfig, isActive: true,
  }).returning({
    id: llmConfigs.id, provider: llmConfigs.provider, createdAt: llmConfigs.createdAt,
  });

  console.log("\nLLM configuration written.");
  console.log(`  id:              ${inserted.id}`);
  console.log(`  provider:        ${inserted.provider}`);
  console.log(`  created_at:      ${inserted.createdAt}`);
  console.log("  api_key:         (stored encrypted)");
  console.log("  base_url:        (stored encrypted)");
  console.log("  model:           (stored encrypted)");
  if (embedding_model) console.log("  embedding_model: (stored encrypted)");
  console.log("");
}

// ---------------------------------------------------------------------------
// llm show
// ---------------------------------------------------------------------------

async function llmShow(db, tenantSlug) {
  const tenant = await findTenant(db, tenantSlug);
  const rows = await db.select({
    id: llmConfigs.id, provider: llmConfigs.provider,
    isActive: llmConfigs.isActive, createdAt: llmConfigs.createdAt,
  }).from(llmConfigs)
    .where(and(eq(llmConfigs.tenantId, tenant.id), eq(llmConfigs.isActive, true)))
    .limit(1);

  if (rows.length === 0) {
    console.log(`\nNo active LLM configuration for tenant "${tenantSlug}".\n`); return;
  }
  const row = rows[0];
  console.log(`\nActive LLM config for "${tenant.name}" (${tenantSlug}):`);
  console.log(`  id:              ${row.id}`);
  console.log(`  provider:        ${row.provider}`);
  console.log(`  is_active:       ${row.isActive}`);
  console.log(`  created_at:      ${row.createdAt}`);
  console.log("  api_key:         (stored encrypted - not shown)");
  console.log("  base_url:        (stored encrypted - not shown)");
  console.log("  model:           (stored encrypted - not shown)");
  console.log("  embedding_model: (stored encrypted - not shown)\n");
}

// ---------------------------------------------------------------------------
// postal-address set
//
// [impl] Same read-modify-write as PATCH /v1/settings/tenant in
// packages/api/src/routes/settings.ts (lines 582-600).
// Merges over existing settings so lifecycle/throttle/brain_context keys
// set by the templates route are preserved.
// ---------------------------------------------------------------------------

async function postalAddressSet(db, tenantSlug, dbInfo) {
  const tenant = await findTenant(db, tenantSlug);
  console.log(`\nTenant: ${tenant.name} (${tenantSlug})`);
  console.log(`Target: ${dbInfo.hostPort}/${dbInfo.dbName} [${dbInfo.type}]`);

  let postalAddress;
  if (isInteractive) {
    console.log("\nEnter the physical postal address required by CAN-SPAM.");
    console.log("This address appears in the footer of every outgoing email.\n");
    postalAddress = await promptField({
      name: "postal_address",
      description: "Physical mailing address of the sending organization",
      required: true,
    });
  } else {
    let p;
    try { p = await readStdinJson(); }
    catch (err) { console.error(`\nERROR: ${err.message}\n`); process.exit(1); }
    postalAddress = p.postal_address;
  }

  if (!postalAddress || postalAddress.trim().length === 0) {
    console.error("\nERROR: postal_address is required.\n"); process.exit(1);
  }
  const trimmed = postalAddress.trim();

  if (isProd) {
    const confirmed = await confirmProduction(dbInfo.hostPort, dbInfo.dbName);
    if (!confirmed) { console.log("\nAborted.\n"); process.exit(0); }
  }

  const ok = await confirmWrite([
    `Tenant:          ${tenant.name} (${tenantSlug})`,
    `Database:        ${dbInfo.hostPort}/${dbInfo.dbName} [${dbInfo.type}]`,
    `postal_address:  ${trimmed}`,
    ...(isProd ? ["Mode:            PRODUCTION (--prod)"] : []),
  ]);
  if (!ok) { console.log("\nAborted.\n"); process.exit(0); }

  const existing = (tenant.settings ?? {});
  const updated = { ...existing, postal_address: trimmed };
  await db.update(tenants).set({ settings: updated }).where(eq(tenants.id, tenant.id));

  console.log("\nPostal address written.");
  console.log(`  postal_address: ${trimmed}\n`);
}

// ---------------------------------------------------------------------------
// postal-address show
// ---------------------------------------------------------------------------

async function postalAddressShow(db, tenantSlug) {
  const tenant = await findTenant(db, tenantSlug);
  const settings = (tenant.settings ?? {});
  const pa = settings.postal_address ?? null;
  if (!pa) {
    console.log(`\nNo postal address configured for "${tenantSlug}".`);
    console.log("  The drain will skip all messages until this is set.");
    console.log(`  Set it: claros postal-address set ${tenantSlug}\n`);
    return;
  }
  console.log(`\nPostal address for "${tenant.name}" (${tenantSlug}):`);
  console.log(`  ${pa}\n`);
}

// ---------------------------------------------------------------------------
// user list / user create / user promote
//
// Minimum CLI surface for user management. A self-hoster who seeds the wrong
// SEED_ADMIN_EMAIL has no way back into the product without these commands.
//
// claros user list <tenant_slug>
//   List all active users for the tenant (email, role, last login).
//
// claros user create <tenant_slug>
//   Create a new user (owner or member). Interactive prompts for email and role.
//   Non-interactive: echo '{"email":"x@y.com","role":"owner"}' | claros user create slug
//
// claros user promote <tenant_slug> <email>
//   Promote an existing user to owner.
// ---------------------------------------------------------------------------

async function userList(db, tenantSlug) {
  const tenant = await findTenant(db, tenantSlug);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), isNull(users.deactivatedAt)));

  console.log(`\nUsers for "${tenant.name}" (${tenantSlug}):`);
  console.log(`${"  "}${"email".padEnd(40)} ${"role".padEnd(8)} ${"last login".padEnd(22)} name`);
  console.log(`${"  "}${"─".repeat(40)} ${"─".repeat(8)} ${"─".repeat(22)} ${"─".repeat(20)}`);
  for (const row of rows) {
    const lastLogin = row.lastLoginAt ? row.lastLoginAt.toISOString().slice(0, 19) : "(never)";
    console.log(`  ${row.email.padEnd(40)} ${row.role.padEnd(8)} ${lastLogin.padEnd(22)} ${row.name ?? ""}`);
  }
  console.log(`\n  Total: ${rows.length} active user${rows.length === 1 ? "" : "s"}\n`);
}

async function userCreate(db, tenantSlug, dbInfo) {
  const tenant = await findTenant(db, tenantSlug);
  console.log(`\nTenant: ${tenant.name} (${tenantSlug})`);
  console.log(`Target: ${dbInfo.hostPort}/${dbInfo.dbName} [${dbInfo.type}]`);

  let payload;
  if (isInteractive) {
    console.log("\nCreate a new user. Required fields are marked Required.\n");
    const email = await promptField({
      name: "email", description: "User email address", required: true,
      validate: validateEmail,
    });
    const role = await promptField({
      name: "role", description: "Role (owner or member)", required: true,
      allowed: ["owner", "member"],
    });
    payload = { email, role };
  } else {
    try { payload = await readStdinJson(); }
    catch (err) { console.error(`\nERROR: ${err.message}\n`); process.exit(1); }
  }

  const { email, role } = payload;
  if (!email || !role) {
    console.error("\nERROR: Required fields: email, role\n"); process.exit(1);
  }
  if (!["owner", "member"].includes(role)) {
    console.error(`\nERROR: role must be "owner" or "member"\n`); process.exit(1);
  }
  const emailErr = validateEmail(email);
  if (emailErr) {
    console.error(`\nERROR: email: ${emailErr}\n`); process.exit(1);
  }

  const normalized = email.toLowerCase().trim();

  if (isProd) {
    const confirmed = await confirmProduction(dbInfo.hostPort, dbInfo.dbName);
    if (!confirmed) { console.log("\nAborted.\n"); process.exit(0); }
  }

  // Check if user already exists (including deactivated)
  const existing = await db
    .select({ id: users.id, deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), eq(users.email, normalized)))
    .limit(1);

  if (existing.length > 0 && !existing[0].deactivatedAt) {
    console.error(`\nERROR: User "${normalized}" already exists and is active in this tenant.\n`);
    process.exit(1);
  }

  if (existing.length > 0 && existing[0].deactivatedAt) {
    // Reactivate
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ role, deactivatedAt: null })
        .where(eq(users.id, existing[0].id));
      await upsertMembership(tx, existing[0].id, tenant.id, role);
    });
    console.log(`\nUser "${normalized}" reactivated with role "${role}".`);
    console.log(`  Generate a login link: claros login-link ${normalized}\n`);
    return;
  }

  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({ tenantId: tenant.id, email: normalized, role })
      .returning({ id: users.id, email: users.email, role: users.role });
    await upsertMembership(tx, row.id, tenant.id, role);
    return row;
  });

  console.log(`\nUser created.`);
  console.log(`  id:    ${inserted.id}`);
  console.log(`  email: ${inserted.email}`);
  console.log(`  role:  ${inserted.role}`);
  console.log(`\n  Generate a login link: claros login-link ${normalized}\n`);
}

/** Keep the user's membership of the tenant in step with users.role (multi-product). */
async function upsertMembership(tx, userId, tenantId, role) {
  await tx
    .insert(memberships)
    .values({ userId, tenantId, role })
    .onConflictDoUpdate({ target: [memberships.userId, memberships.tenantId], set: { role } });
}

async function userPromote(db, tenantSlug, email, dbInfo) {
  const tenant = await findTenant(db, tenantSlug);
  const normalized = email.toLowerCase().trim();

  const rows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(
      eq(users.tenantId, tenant.id),
      eq(users.email, normalized),
      isNull(users.deactivatedAt),
    ))
    .limit(1);

  if (rows.length === 0) {
    console.error(`\nERROR: No active user "${normalized}" in tenant "${tenantSlug}".\n`);
    process.exit(1);
  }

  const user = rows[0];
  if (user.role === "owner") {
    console.log(`\nUser "${normalized}" is already an owner. Nothing to do.\n`);
    return;
  }

  if (isProd) {
    const confirmed = await confirmProduction(dbInfo.hostPort, dbInfo.dbName);
    if (!confirmed) { console.log("\nAborted.\n"); process.exit(0); }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ role: "owner" })
      .where(eq(users.id, user.id));
    await upsertMembership(tx, user.id, tenant.id, "owner");
  });

  console.log(`\nUser "${normalized}" promoted to owner.`);
  console.log(`  Tenant: ${tenant.name} (${tenantSlug})`);
  console.log(`  Target: ${dbInfo.hostPort}/${dbInfo.dbName} [${dbInfo.type}]\n`);
}

// ---------------------------------------------------------------------------
// setup - guided first-run wizard
//
// Walks through postal address, LLM provider, and transport provider in the
// order the system requires them. Shows what is already configured and leaves
// it alone unless the operator chooses to change it. Safe to re-run.
//
// Order:
//   1. Postal address (required before any email can leave; no credentials)
//   2. LLM provider   (required for flow compilation; api_key is a secret)
//   3. Transport      (required to send email; api_key is a secret)
//
// What happens when a step is skipped:
//   The wizard prints what would be blocked without that step and moves on.
//   The operator can tell what remains unconfigured from the skipped summary
//   and from the "what's still missing" block at the end.
// ---------------------------------------------------------------------------

async function cmdSetup(db, tenantSlug, dbInfo) {
  const tenant = await findTenant(db, tenantSlug);
  const settings = (tenant.settings ?? {});
  const existingPostal = settings.postal_address ?? null;

  const existingLlm = await db.select({
    id: llmConfigs.id, provider: llmConfigs.provider,
  }).from(llmConfigs)
    .where(and(eq(llmConfigs.tenantId, tenant.id), eq(llmConfigs.isActive, true)))
    .limit(1);

  const existingTransport = await db.select({
    id: transportConfigs.id, provider: transportConfigs.provider,
    fromEmail: transportConfigs.fromEmail,
  }).from(transportConfigs)
    .where(and(eq(transportConfigs.tenantId, tenant.id), eq(transportConfigs.isActive, true)))
    .limit(1);

  console.log("");
  console.log("=== Claros Setup Wizard ===");
  console.log(`Tenant: ${tenant.name} (${tenantSlug})`);
  console.log(`Target: ${dbInfo.hostPort}/${dbInfo.dbName} [${dbInfo.type}]`);
  console.log("");
  console.log("This wizard walks through the three required configuration steps.");
  console.log("Anything already configured is shown; you can keep it or replace it.");
  console.log("Press Enter to skip any optional prompt or accept its default.");
  console.log("");

  const stillMissing = [];

  // -------------------------------------------------------------------------
  // Step 1: Postal address
  // -------------------------------------------------------------------------

  console.log("--- Step 1 of 3: Postal address ---");
  console.log("");
  console.log("Why: CAN-SPAM requires a physical mailing address in every outgoing email.");
  console.log("     No email leaves the system until this is set.");
  console.log("");

  if (existingPostal) {
    console.log(`  Current: ${existingPostal}`);
    const change = await readLineInteractive("  Replace it? [y/N] ");
    if (change.trim().toLowerCase() === "y" || change.trim().toLowerCase() === "yes") {
      await postalAddressSet(db, tenantSlug, dbInfo);
    } else {
      console.log("  Keeping existing postal address.\n");
    }
  } else {
    console.log("  Not configured. Enter one now, or press Enter to skip.");
    console.log("  (Skipping blocks all email sending until you set it.)\n");
    const addr = await promptField({
      name: "postal_address", description: "Physical mailing address", required: false,
    });
    if (addr) {
      const trimmed = addr.trim();
      const merged = { ...(tenant.settings ?? {}), postal_address: trimmed };
      await db.update(tenants).set({ settings: merged }).where(eq(tenants.id, tenant.id));
      console.log(`  Saved: ${trimmed}\n`);
    } else {
      console.log("  Skipped. Run: claros postal-address set " + tenantSlug);
      console.log("");
      stillMissing.push("postal-address set " + tenantSlug + "  (blocks all email sending)");
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: LLM provider
  // -------------------------------------------------------------------------

  console.log("--- Step 2 of 3: LLM provider ---");
  console.log("");
  console.log("Why: required for flow compilation (converts prompt-defined flows into");
  console.log("     deterministic execution plans) and KB entry embedding.");
  console.log("     Email can be sent without this, but no content is generated.");
  console.log("");

  if (existingLlm.length > 0) {
    const l = existingLlm[0];
    console.log(`  Current: ${l.provider} (id: ${l.id})`);
    const change = await readLineInteractive("  Replace it? [y/N] ");
    if (change.trim().toLowerCase() === "y" || change.trim().toLowerCase() === "yes") {
      await llmSet(db, tenantSlug, dbInfo);
    } else {
      console.log("  Keeping existing LLM configuration.\n");
    }
  } else {
    console.log("  Not configured. Enter credentials now, or press Enter at provider to skip.");
    console.log("  (Skipping means flows cannot be compiled.)\n");

    const provider = await promptField({
      name: "provider", description: "LLM provider (press Enter to skip)",
      required: false, allowed: KNOWN_LLM_PROVIDERS,
    });

    if (provider) {
      const api_key = await promptField({
        name: "api_key", description: "Provider API key", required: true, secret: true,
      });
      const defaultBaseUrl = LLM_DEFAULT_BASE_URL[provider] ?? null;
      const base_url = await promptField({
        name: "base_url", description: "OpenAI-compatible API base URL",
        required: defaultBaseUrl === null,
        defaultValue: defaultBaseUrl,
      });
      const model = await promptField({
        name: "model", description: "Model identifier (e.g. gpt-4o)", required: true,
      });
      const embedding_model = await promptField({
        name: "embedding_model", description: "Embedding model (must produce vector(1536))",
        required: false, defaultValue: "text-embedding-3-small",
      });

      if (isProd) {
        const confirmed = await confirmProduction(dbInfo.hostPort, dbInfo.dbName);
        if (!confirmed) {
          console.log("\nAborted LLM step.\n");
          stillMissing.push("llm set " + tenantSlug + "  (required for flow compilation)");
        } else {
          const ok = await confirmWrite([
            `provider:        ${provider}`,
            `api_key:         (present, ${api_key.length} chars)`,
            `base_url:        ${base_url}`,
            `model:           ${model}`,
            `embedding_model: ${embedding_model || "(default)"}`,
          ]);
          if (ok) {
            const encKey = resolveEncryptionKey();
            const creds = { apiKey: api_key, baseUrl: base_url, model };
            if (embedding_model) creds.embedding_model = embedding_model;
            const enc = encrypt(JSON.stringify(creds), encKey);
            await db.update(llmConfigs).set({ isActive: false })
              .where(and(eq(llmConfigs.tenantId, tenant.id), eq(llmConfigs.isActive, true)));
            const [ins] = await db.insert(llmConfigs).values({
              tenantId: tenant.id, provider, config: enc, isActive: true,
            }).returning({ id: llmConfigs.id });
            console.log(`  LLM saved (id: ${ins.id})\n`);
          } else {
            console.log("  Skipped.\n");
            stillMissing.push("llm set " + tenantSlug + "  (required for flow compilation)");
          }
        }
      } else {
        const ok = await confirmWrite([
          `provider:        ${provider}`,
          `api_key:         (present, ${api_key.length} chars)`,
          `base_url:        ${base_url}`,
          `model:           ${model}`,
          `embedding_model: ${embedding_model || "(default)"}`,
        ]);
        if (ok) {
          const encKey = resolveEncryptionKey();
          const creds = { apiKey: api_key, baseUrl: base_url, model };
          if (embedding_model) creds.embedding_model = embedding_model;
          const enc = encrypt(JSON.stringify(creds), encKey);
          await db.update(llmConfigs).set({ isActive: false })
            .where(and(eq(llmConfigs.tenantId, tenant.id), eq(llmConfigs.isActive, true)));
          const [ins] = await db.insert(llmConfigs).values({
            tenantId: tenant.id, provider, config: enc, isActive: true,
          }).returning({ id: llmConfigs.id });
          console.log(`  LLM saved (id: ${ins.id})\n`);
        } else {
          console.log("  Skipped.\n");
          stillMissing.push("llm set " + tenantSlug + "  (required for flow compilation)");
        }
      }
    } else {
      console.log("  Skipped. Run: claros llm set " + tenantSlug);
      console.log("");
      stillMissing.push("llm set " + tenantSlug + "  (required for flow compilation)");
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Transport provider
  // -------------------------------------------------------------------------

  console.log("--- Step 3 of 3: Transport provider (email delivery) ---");
  console.log("");
  console.log("Why: required to send email. Without this, approved messages queue up");
  console.log("     but nothing is delivered. You will also need to verify your sender");
  console.log("     domain with your provider (outside Claros).");
  console.log("");

  if (existingTransport.length > 0) {
    const t = existingTransport[0];
    console.log(`  Current: ${t.provider}, from ${t.fromEmail}`);
    const change = await readLineInteractive("  Replace it? [y/N] ");
    if (change.trim().toLowerCase() === "y" || change.trim().toLowerCase() === "yes") {
      await transportSet(db, tenantSlug, dbInfo);
    } else {
      console.log("  Keeping existing transport configuration.\n");
    }
  } else {
    console.log("  Not configured. Enter credentials now, or press Enter at provider to skip.");
    console.log("  (Skipping means no email is sent.)\n");

    const provider = await promptField({
      name: "provider", description: "Email provider (press Enter to skip)",
      required: false, allowed: KNOWN_TRANSPORT_PROVIDERS,
    });

    if (provider) {
      const from_email = await promptField({
        name: "from_email", description: "Sender address (From: header)", required: true,
        validate: validateEmail,
      });
      const from_name = await promptField({
        name: "from_name", description: "Sender display name", required: false,
      });
      const api_key = await promptField({
        name: "api_key", description: "Provider API key", required: true, secret: true,
      });
      const webhook_secret = await promptField({
        name: "webhook_secret", description: "Webhook signing secret (optional)",
        required: false, secret: true,
      });

      const writeTransport = async () => {
        const encKey = resolveEncryptionKey();
        const creds = { apiKey: api_key };
        if (webhook_secret) creds.webhookSecret = webhook_secret;
        const enc = encrypt(JSON.stringify(creds), encKey);
        await db.update(transportConfigs).set({ isActive: false })
          .where(and(eq(transportConfigs.tenantId, tenant.id), eq(transportConfigs.isActive, true)));
        const [ins] = await db.insert(transportConfigs).values({
          tenantId: tenant.id, provider,
          config: sql`${enc}::jsonb`,
          isActive: true, fromEmail: from_email,
          fromName: from_name ?? null, dailyLimit: null,
        }).returning({ id: transportConfigs.id });
        console.log(`  Transport saved (id: ${ins.id})`);
        console.log(`  NOTE: Verify your sender domain (${from_email}) with ${provider}.\n`);
      };

      if (isProd) {
        const confirmed = await confirmProduction(dbInfo.hostPort, dbInfo.dbName);
        if (!confirmed) {
          console.log("\nAborted transport step.\n");
          stillMissing.push("transport set " + tenantSlug + "  (required to send email)");
        } else {
          const ok = await confirmWrite([
            `provider:        ${provider}`,
            `from_email:      ${from_email}`,
            `api_key:         (present, ${api_key.length} chars)`,
          ]);
          if (ok) { await writeTransport(); }
          else {
            console.log("  Skipped.\n");
            stillMissing.push("transport set " + tenantSlug + "  (required to send email)");
          }
        }
      } else {
        const ok = await confirmWrite([
          `provider:        ${provider}`,
          `from_email:      ${from_email}`,
          `api_key:         (present, ${api_key.length} chars)`,
        ]);
        if (ok) { await writeTransport(); }
        else {
          console.log("  Skipped.\n");
          stillMissing.push("transport set " + tenantSlug + "  (required to send email)");
        }
      }
    } else {
      console.log("  Skipped. Run: claros transport set " + tenantSlug);
      console.log("");
      stillMissing.push("transport set " + tenantSlug + "  (required to send email)");
    }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  console.log("=== Setup complete ===");
  console.log("");

  // Check whether UNSUBSCRIBE_SIGNING_KEY is set. This key is not written by
  // the wizard (it is an environment variable, not a database credential), but
  // if it is absent the drain will block all sending regardless of how the
  // database configuration looks. Alert the operator here so they do not finish
  // setup and then wonder why no mail leaves.
  const signingKeySet = !!(process.env.UNSUBSCRIBE_SIGNING_KEY ?? "").trim();
  if (!signingKeySet) {
    console.log("IMPORTANT: UNSUBSCRIBE_SIGNING_KEY is not set in your environment.");
    console.log("  Without this key, the drain blocks all sending. Set it in .env:");
    console.log("");
    console.log("  Generate (run once, store permanently, never rotate):");
    console.log("    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    console.log("  Then add to .env:");
    console.log("    UNSUBSCRIBE_SIGNING_KEY=<generated-value>");
    console.log("  Then restart the server.");
    console.log("");
  }

  if (stillMissing.length === 0) {
    if (signingKeySet) {
      console.log("All three configuration steps are done.");
    } else {
      console.log("Database configuration steps are done (see key warning above).");
    }
    console.log("Get your login link:");
    console.log("");
    console.log("  claros login-link <your-email>");
    console.log("  docker compose exec app claros login-link <email>");
    console.log("");
  } else {
    console.log("Steps still needed:");
    for (const m of stillMissing) console.log(`  claros ${m}`);
    console.log("");
    console.log("Re-run `claros setup` at any time to complete the remaining steps.");
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// doctor
//
// Read-only diagnostic command. NEVER writes to the database.
//
// Sections:
//   Deployment  - local HEAD (git) vs. deployed commit (GET /version)
//   Database    - connection target, migration count and name
//   Transport   - resend row counts, decryption check, credential key names,
//                 webhookSecret fingerprint
//   Environment - for each secret key: LOCAL fingerprint (this machine's env),
//                 CONTAINER fingerprint (from GET /v1/diagnostics), MATCH/MISMATCH.
//                 BASE_URL and edition are shown from the container's perspective.
//
// Authentication for /v1/diagnostics:
//   The endpoint is behind the /v1 session-cookie preHandler. Doctor passes the
//   session token supplied via --session <token> or CLAROS_DOCTOR_SESSION env var
//   as a claros_session cookie. Without a token the Environment section is skipped.
//
// All failures are non-fatal. The command always finishes and prints what it could.
//
// Security invariant: no secret, key, credential, or password is printed anywhere.
// Fingerprints (first 8 hex chars of SHA-256) and byte lengths only.
// ---------------------------------------------------------------------------

/**
 * Fetch JSON from a URL using the built-in http/https modules.
 * Optionally passes a session cookie for authenticated endpoints.
 * Returns { ok: true, data } or { ok: false, error: string }.
 */
async function fetchJson(url, sessionToken) {
  try {
    const m = url.startsWith("https") ? await import("node:https") : await import("node:http");
    return await new Promise((resolve) => {
      const headers = {};
      if (sessionToken) headers["Cookie"] = `claros_session=${sessionToken}`;
      const req = m.get(url, { timeout: 5000, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({ ok: false, error: `HTTP ${res.statusCode} (session token invalid or expired)` });
            return;
          }
          try {
            resolve({ ok: true, data: JSON.parse(body), status: res.statusCode });
          } catch {
            resolve({ ok: false, error: `Non-JSON response (status ${res.statusCode}): ${body.slice(0, 80)}` });
          }
        });
      });
      req.on("error", (err) => resolve({ ok: false, error: err.message }));
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "Request timed out (5s)" }); });
    });
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
}

/**
 * Compute first 8 hex chars of SHA-256 of a raw string (the env var value as-is).
 * Used as a non-reversible fingerprint: two machines can compare values without
 * either one learning the other's value.
 */
function fpOfRaw(val) {
  return createHash("sha256").update(Buffer.from(val, "utf8")).digest("hex").slice(0, 8);
}

/**
 * Validate the /version URL when --prod is in effect.
 * Returns an error string if the URL is unsafe, or null if it is acceptable.
 * With --prod, localhost and non-https targets are refused to prevent doctor
 * from silently querying the wrong server.
 */
function validateProdVersionUrl(url) {
  if (!url) return "BASE_URL is not set; pass --url or set CLAROS_DOCTOR_URL";
  let parsed;
  try { parsed = new URL(url); } catch { return `Not a valid URL: ${url}`; }
  const host = parsed.hostname;
  const isLoopback = host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\./.test(host);
  if (isLoopback) return `URL points at localhost (${url}). With --prod, doctor refuses localhost targets to avoid querying the wrong server. Set CLAROS_DOCTOR_URL to the production URL.`;
  if (parsed.protocol !== "https:") return `URL is not https (${url}). With --prod, doctor refuses non-https targets. Set CLAROS_DOCTOR_URL to the https production URL.`;
  return null;
}

async function cmdDoctor(db, dbInfo, sessionToken) {
  const lines = [];
  const out = (s = "") => lines.push(s);
  const section = (title) => { out(); out(`  ${title}`); out(`  ${"─".repeat(title.length)}`); };

  out("╔══════════════════════════════════════════════════════════╗");
  out("║            claros doctor - deployment diagnostic          ║");
  out("╚══════════════════════════════════════════════════════════╝");

  // -------------------------------------------------------------------------
  // Deployment: local HEAD vs. deployed commit
  // -------------------------------------------------------------------------
  section("Deployment");

  let localHead = "UNKNOWN";
  try {
    localHead = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8", timeout: 5000 }).trim();
    out(`    local HEAD:      ${localHead}`);
  } catch (err) {
    // git is not available inside the container image (node:22-alpine has no git).
    // When running inside a container, the deployed commit is visible via the
    // /version endpoint below; the local HEAD comparison does not apply there.
    const isGitMissing = /not found|ENOENT|No such file/i.test(err.message);
    if (isGitMissing) {
      out(`    local HEAD:      git not available (running inside container - see deployed commit below)`);
    } else {
      out(`    local HEAD:      ERROR - ${err.message.trim()}`);
    }
  }

  // Determine the /version URL to query.
  // --prod requires https and non-localhost; refused otherwise.
  // Without --prod defaults to http://localhost:3000.
  const rawDoctorUrl = (process.env.CLAROS_DOCTOR_URL
    ?? (isProd ? (process.env.BASE_URL ?? "").replace(/\/$/, "") : "http://localhost:3000")) || "";

  let versionUrl = rawDoctorUrl;
  if (isProd) {
    const urlErr = validateProdVersionUrl(rawDoctorUrl);
    if (urlErr) {
      out(`    version URL:     REFUSED - ${urlErr}`);
      out("    deployed commit: UNKNOWN");
      versionUrl = "";
    }
  }

  let deployedCommit = null;
  let deployedBuiltAt = null;
  if (versionUrl) {
    const versionEndpoint = `${versionUrl}/version`;
    out(`    version URL:     ${versionEndpoint}`);
    const result = await fetchJson(versionEndpoint);
    if (result.ok) {
      deployedCommit  = result.data.commit  ?? "unknown";
      deployedBuiltAt = result.data.builtAt ?? null;
      out(`    deployed commit: ${deployedCommit}`);
      if (deployedBuiltAt) out(`    built at:        ${deployedBuiltAt}`);
    } else {
      out(`    deployed commit: UNREACHABLE (${result.error})`);
      out("    (database sections will still run)");
    }
  }

  // The single most important line in the output.
  // Uses compareCommits() from doctor-compare.mjs (tested independently).
  if (deployedCommit !== null || versionUrl === "") {
    const commitResult = compareCommits(localHead, deployedCommit);
    for (const line of formatCommitVerdict(commitResult)) out(line);
  }

  // -------------------------------------------------------------------------
  // Database
  // -------------------------------------------------------------------------
  section("Database");
  out(`    host/db:    ${dbInfo.hostPort}/${dbInfo.dbName}`);
  out(`    type:       ${dbInfo.type}`);

  // Detect SSL from the connection URL
  let sslInUse = "unknown";
  try {
    const rawUrl = resolveDbUrl();
    const parsed = new URL(rawUrl);
    const sslParam = parsed.searchParams.get("ssl") ?? parsed.searchParams.get("sslmode") ?? "";
    if (/require|verify|true/i.test(sslParam) || /neon\.tech/i.test(parsed.hostname)) {
      sslInUse = "yes";
    } else if (sslParam === "" && /localhost|127\.0\.0\.|::1/.test(parsed.hostname)) {
      sslInUse = "no (localhost)";
    } else {
      sslInUse = sslParam || "not specified in URL";
    }
  } catch { /* leave as unknown */ }
  out(`    SSL:        ${sslInUse}`);

  // Migration state: query drizzle_migrations table directly.
  // Drizzle uses "drizzle"."__drizzle_migrations" table (schema "drizzle").
  // The table stores only hash and created_at (bigint epoch ms). The migration
  // name/tag lives only in the journal file on disk. Correlate by timestamp.
  try {
    const migResult = await db.execute(
      sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC`
    );
    const rows = migResult.rows ?? [];
    if (rows.length === 0) {
      out("    migrations: 0 applied (table exists but is empty)");
    } else {
      // Load journal for name lookup. Journal path is relative to repo root.
      // If the journal is absent (e.g. inside a container that did not copy it),
      // fall back to the hash so the line is still informative.
      let tagByTs = {};
      try {
        const journalPath = resolve(repoRoot, "drizzle/migrations/meta/_journal.json");
        const journal = JSON.parse(readFileSync(journalPath, "utf8"));
        for (const entry of (journal.entries ?? [])) {
          tagByTs[String(entry.when)] = entry.tag;
        }
      } catch { /* journal absent - tags stay empty */ }

      const latest = rows[rows.length - 1];
      const latestTs = String(latest.created_at);
      const latestName = tagByTs[latestTs] ?? latest.hash ?? "(unknown)";
      out(`    migrations: ${rows.length} applied`);
      out(`    latest:     ${latestName}`);
    }
  } catch (err) {
    out(`    migrations: ERROR - ${err.message.trim()}`);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------
  section("Transport");

  try {
    const allTransports = await db
      .select({
        isActive: transportConfigs.isActive,
        config:   transportConfigs.config,
        id:       transportConfigs.id,
        provider: transportConfigs.provider,
      })
      .from(transportConfigs);

    const active   = allTransports.filter((r) => r.isActive);
    const inactive = allTransports.filter((r) => !r.isActive);
    // Group by provider for display
    const providerCounts = {};
    for (const row of allTransports) {
      const key = row.provider ?? "unknown";
      providerCounts[key] = providerCounts[key] || { active: 0, inactive: 0 };
      if (row.isActive) providerCounts[key].active++;
      else providerCounts[key].inactive++;
    }
    for (const [prov, counts] of Object.entries(providerCounts)) {
      out(`    ${prov} rows:  active=${counts.active}  inactive=${counts.inactive}`);
    }
    if (Object.keys(providerCounts).length === 0) {
      out("    no transport configured");
    }

    if (active.length > 0) {
      const row = active[0];
      const encKey = process.env.ENCRYPTION_KEY;
      if (!encKey) {
        out("    active row:   decryption SKIPPED (LOCAL ENCRYPTION_KEY not set)");
      } else {
        try {
          const key = parseEncryptionKey(encKey);
          const configVal = typeof row.config === "string" ? row.config : JSON.stringify(row.config);
          const plain = JSON.parse(decrypt(configVal, key));
          const credKeys = Object.keys(plain).sort();
          out("    active row:   decryption OK");
          out(`    cred keys:    ${credKeys.join(", ")}`);
          if (plain.webhookSecret) {
            const fp = fpOfRaw(plain.webhookSecret);
            out(`    webhookSecret fingerprint: ${fp}... (first 8 hex chars of SHA-256)`);
          } else {
            out("    webhookSecret: not present");
          }
        } catch (err) {
          out(`    active row:   decryption ERROR - ${err.message}`);
        }
      }
    }
  } catch (err) {
    out(`    transport:    ERROR - ${err.message.trim()}`);
  }

  // -------------------------------------------------------------------------
  // Environment: LOCAL vs. CONTAINER comparison
  //
  // LOCAL values come from process.env on this machine (the operator's shell).
  // CONTAINER values come from GET /v1/diagnostics on the running container.
  //
  // Without a session token the container section is skipped entirely, and the
  // local values are printed with a LOCAL label so nobody mistakes them for
  // the container's environment.
  // -------------------------------------------------------------------------
  section("Environment");

  // --- LOCAL fingerprints (this machine) ---
  // encoding: "base64" for ENCRYPTION_KEY, "hex" for UNSUBSCRIBE_SIGNING_KEY.
  // Both sides (local and container) decode before fingerprinting so the
  // comparison is meaningful: same decoded bytes -> same fingerprint.
  function localKeyInfo(name, encoding) {
    const val = process.env[name];
    if (!val) return { present: false, byteLength: null, fingerprint: null, decodeError: null };
    try {
      const decoded = Buffer.from(val, encoding);
      if (decoded.length === 0) {
        return { present: true, byteLength: null, fingerprint: null, decodeError: `decoded to 0 bytes (encoding: ${encoding})` };
      }
      const fp = createHash("sha256").update(decoded).digest("hex").slice(0, 8);
      return { present: true, byteLength: decoded.length, fingerprint: fp, decodeError: null };
    } catch (err) {
      return { present: true, byteLength: null, fingerprint: null, decodeError: err.message };
    }
  }

  // ENCRYPTION_KEY is base64-encoded; UNSUBSCRIBE_SIGNING_KEY is hex-encoded.
  const localEnc = localKeyInfo("ENCRYPTION_KEY",         "base64");
  const localSig = localKeyInfo("UNSUBSCRIBE_SIGNING_KEY", "hex");

  // --- CONTAINER fingerprints (from /v1/diagnostics) ---
  let containerKeys = null;
  let containerBaseUrl = null;
  let diagnosticsSkipReason = null;

  if (!sessionToken) {
    diagnosticsSkipReason = "no session token (pass --session <token> or set CLAROS_DOCTOR_SESSION)";
  } else if (!versionUrl) {
    diagnosticsSkipReason = "version URL was refused or unset";
  } else {
    const diagEndpoint = `${versionUrl}/v1/diagnostics`;
    const diagResult = await fetchJson(diagEndpoint, sessionToken);
    if (diagResult.ok) {
      containerKeys    = diagResult.data.keys ?? null;
      containerBaseUrl = null; // /v1/diagnostics does not expose BASE_URL (not a secret but not needed here)
    } else {
      diagnosticsSkipReason = `GET /v1/diagnostics: ${diagResult.error}`;
    }
  }

  // Uses formatKeyVerdict() / compareKeyFingerprints() from doctor-compare.mjs (tested).
  for (const line of formatKeyVerdict("ENCRYPTION_KEY",         localEnc, containerKeys ? containerKeys["ENCRYPTION_KEY"]         : null, diagnosticsSkipReason)) out(line);
  for (const line of formatKeyVerdict("UNSUBSCRIBE_SIGNING_KEY", localSig, containerKeys ? containerKeys["UNSUBSCRIBE_SIGNING_KEY"] : null, diagnosticsSkipReason)) out(line);

  // Edition and BASE_URL: container's view (from /version response data we already have)
  out("");
  if (deployedCommit !== null && versionUrl) {
    // Re-fetch /version for edition - it was already fetched above; reuse deployedCommit data
    // Edition is in /version response; we stored it but need to surface it here.
    // We stored deployedCommit but not edition - fetch diagnostics has it if available.
  }
  // Local BASE_URL
  const localBaseUrl = process.env.BASE_URL ?? "(not set)";
  const isHttps = localBaseUrl.startsWith("https://");
  out(`    BASE_URL (local):  ${localBaseUrl}  ${isHttps ? "[https: OK]" : localBaseUrl === "(not set)" ? "" : "[WARNING: not https]"}`);

  out("");
  out("═".repeat(62));
  out("  doctor complete");
  out("═".repeat(62));
  out("");

  // Print all at once so the output is never interleaved with other log lines
  for (const line of lines) console.log(line);
}

// ---------------------------------------------------------------------------
// claros install
//
// Machine-level setup that runs before anything else. Creates .env with
// generated secrets, tests the database connection, and applies migrations.
// Designed to run as a one-off container (docker compose run --rm install)
// or directly on the host (node claros.mjs install).
//
// Safe to run twice: existing .env is read and only missing keys are filled.
// ---------------------------------------------------------------------------

async function cmdInstall(args) {
  const hostRootIdx = args.indexOf("--host-root");
  const hostRoot = (hostRootIdx >= 0 && args[hostRootIdx + 1])
    ? args[hostRootIdx + 1]
    : repoRoot;
  const envPath = resolve(hostRoot, ".env");
  const envExamplePath = resolve(repoRoot, ".env.example");

  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                     Claros Install                          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");

  // Step 1: .env file
  let envContent = "";
  let envExisted = false;
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, "utf8");
    envExisted = true;
    console.log("  .env found - checking for missing keys...");
  } else if (existsSync(envExamplePath)) {
    envContent = readFileSync(envExamplePath, "utf8");
    console.log("  .env created from .env.example");
  } else {
    console.error("  ERROR: Neither .env nor .env.example found.");
    process.exit(1);
  }

  // Step 2: Generate secrets if missing
  function getEnvValue(content, key) {
    const re = new RegExp(`^${key}=(.*)$`, "m");
    const match = content.match(re);
    if (!match) return null;
    let val = match[1].trim();
    if ((val.startsWith("'") && val.endsWith("'")) ||
        (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    return val || null;
  }

  function setEnvValue(content, key, value) {
    // If key exists as a comment (# KEY=), uncomment and set
    const commented = new RegExp(`^#\\s*${key}=.*$`, "m");
    if (commented.test(content)) {
      return content.replace(commented, `${key}='${value}'`);
    }
    // If key exists with empty/no value, replace
    const existing = new RegExp(`^${key}=.*$`, "m");
    if (existing.test(content)) {
      return content.replace(existing, `${key}='${value}'`);
    }
    // Append
    return content.trimEnd() + `\n${key}='${value}'\n`;
  }

  let encKey = getEnvValue(envContent, "ENCRYPTION_KEY");
  let signKey = getEnvValue(envContent, "UNSUBSCRIBE_SIGNING_KEY");
  let generated = [];

  if (!encKey) {
    encKey = randomBytes(32).toString("base64");
    envContent = setEnvValue(envContent, "ENCRYPTION_KEY", encKey);
    generated.push("ENCRYPTION_KEY");
  }
  if (!signKey) {
    signKey = randomBytes(32).toString("hex");
    envContent = setEnvValue(envContent, "UNSUBSCRIBE_SIGNING_KEY", signKey);
    generated.push("UNSUBSCRIBE_SIGNING_KEY");
  }

  // Step 3: Database URL
  // --database-url flag allows specifying an external Postgres directly.
  const dbUrlFlagIdx = args.indexOf("--database-url");
  const externalDbUrl = (dbUrlFlagIdx >= 0 && args[dbUrlFlagIdx + 1])
    ? args[dbUrlFlagIdx + 1]
    : null;

  let dbUrl = externalDbUrl || getEnvValue(envContent, "DATABASE_URL");
  const bundledUrl = "postgres://claros:claros@postgres:5432/claros";
  const isContainer = existsSync("/.dockerenv") || process.env.container === "docker";

  // dbNote is printed after the .env write alongside generated key names.
  let dbNote = "";

  if (externalDbUrl) {
    // Explicit external database - validate and write to .env
    envContent = setEnvValue(envContent, "DATABASE_URL", externalDbUrl);
    dbUrl = externalDbUrl;
    generated.push("DATABASE_URL (external)");
    dbNote = `  Database:  external (${dbUrl.replace(/:[^:@]+@/, ":***@")})`;
  } else if (!dbUrl) {
    if (isContainer) {
      dbUrl = bundledUrl;
      // Write the host-facing URL to .env (localhost:5433 is the host port mapping)
      envContent = setEnvValue(envContent, "DATABASE_URL", "postgres://claros:claros@localhost:5433/claros");
    } else {
      dbUrl = "postgres://claros:claros@localhost:5433/claros";
      envContent = setEnvValue(envContent, "DATABASE_URL", dbUrl);
    }
    generated.push("DATABASE_URL (bundled Postgres)");
    dbNote = "  Database:  bundled Postgres (compose stack)\n" +
             "             To use your own: add --database-url 'postgres://...' to the command.";
  } else {
    // Use existing URL from .env (could have been copied from .env.example)
    const displayUrl = dbUrl.replace(/:[^:@]+@/, ":***@");
    if (isContainer && (dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1"))) {
      // Inside container, localhost means the compose postgres service
      dbUrl = bundledUrl;
    }
    // Detect the default bundled URL from .env.example so the message is useful
    const isBundledDefault =
      dbUrl.includes("localhost:5433") ||
      dbUrl.includes("postgres:5432") ||
      dbUrl === bundledUrl;
    if (isBundledDefault) {
      dbNote = "  Database:  bundled Postgres (compose stack)\n" +
               "             To use your own: add --database-url 'postgres://...' to the command.";
    } else {
      dbNote = `  Database:  ${displayUrl} (from .env)`;
    }
  }

  // Write .env 0600, then chown to the owner of the host directory.
  //
  // The install service mounts the project root at /hostfs. The /hostfs
  // directory itself is owned by the host user (on Linux the real UID/GID
  // are visible; on macOS Docker Desktop VirtioFS maps ownership automatically
  // and no chown is needed). We stat /hostfs to get the owner UID/GID and
  // apply them to .env so the person can edit the file without sudo.
  //
  // Cases:
  //   /hostfs UID != 0  - Linux with non-root host user, or running with
  //                       CLAROS_UID/CLAROS_GID set. chown to those values.
  //   /hostfs UID == 0  - Two sub-cases:
  //     macOS Docker Desktop: VirtioFS already maps the file to the host user
  //       on the host side. No chown needed; the file is accessible.
  //     Linux with root container and no UID override: file is root-owned.
  //       We cannot determine the correct owner from inside the container.
  //       Warn with the override command.
  writeFileSync(envPath, envContent, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(envPath, 0o600); } catch { /* VirtioFS may not support; ignore */ }

  let hostDirUid = 0;
  let hostDirGid = 0;
  try {
    const hostStat = statSync(hostRoot);
    hostDirUid = hostStat.uid;
    hostDirGid = hostStat.gid;
  } catch {
    // stat failed (e.g. running outside a container with no /hostfs); ignore.
  }

  if (hostDirUid !== 0 || hostDirGid !== 0) {
    // Host directory has a non-root owner. chown the file to match.
    try {
      chownSync(envPath, hostDirUid, hostDirGid);
    } catch {
      // chown may fail if running without CAP_CHOWN. Not fatal.
    }
  } else {
    // /hostfs is root:root. This is expected on macOS Docker Desktop (VirtioFS
    // remaps the file to the host user on the host side automatically) and
    // acceptable on Linux where the person is running as root anyway.
    // If running as root in a Linux container without macOS remapping, warn.
    const isContainer = existsSync("/.dockerenv");
    const onLinux = process.platform === "linux";
    if (isContainer && onLinux) {
      console.log("  Note: running as root inside a Linux container. .env is mode 0600.");
      console.log("  If the file ends up owned by root on the host and you cannot edit it:");
      console.log("    CLAROS_UID=$(id -u) CLAROS_GID=$(id -g) docker compose run --rm install");
    }
  }

  if (generated.length > 0) {
    console.log(`  Generated: ${generated.join(", ")}`);
  } else {
    console.log("  All keys present - no changes to .env");
  }
  if (dbNote) console.log(dbNote);

  // Remove SEED_ADMIN_EMAIL default if still the placeholder
  const seedEmail = getEnvValue(envContent, "SEED_ADMIN_EMAIL");
  if (seedEmail === "admin@example.com") {
    // Clear it - the claim flow will handle first login
    envContent = envContent.replace(
      /^SEED_ADMIN_EMAIL='admin@example\.com'$/m,
      "# SEED_ADMIN_EMAIL="
    );
    writeFileSync(envPath, envContent, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(envPath, 0o600); } catch { /* ignore */ }
    if (hostDirUid !== 0 || hostDirGid !== 0) {
      try { chownSync(envPath, hostDirUid, hostDirGid); } catch { /* ignore */ }
    }
    console.log("  Cleared default SEED_ADMIN_EMAIL (claim flow will handle first login)");
  }

  // Step 4: Test database connection
  console.log("");
  console.log("  Testing database connection...");
  let testPool;
  try {
    testPool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: 10000 });
    const res = await testPool.query("SELECT 1 AS ok");
    if (res.rows[0]?.ok !== 1) throw new Error("SELECT 1 did not return expected result");
    console.log("  Database connection OK");
  } catch (err) {
    console.error(`  ERROR: Cannot connect to database: ${err.message}`);
    console.error(`  URL: ${dbUrl.replace(/:[^:@]+@/, ":***@")}`);
    if (isContainer) {
      console.error("  The bundled Postgres should be reachable as 'postgres:5432' inside the compose network.");
    }
    process.exit(1);
  }

  // Step 5: Run migrations
  console.log("  Running migrations...");
  try {
    const testDb = drizzle(testPool);
    const migrationsFolder = resolve(repoRoot, "drizzle/migrations");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(testDb, { migrationsFolder });
    console.log("  Migrations applied");
  } catch (err) {
    console.error(`  ERROR: Migration failed: ${err.message}`);
    process.exit(1);
  } finally {
    await testPool.end();
  }

  // Step 5b: npm install in the host directory.
  //
  // The compose dev-stage mounts ./apps, ./packages, and ./drizzle into the
  // app container. The container's entrypoint rebuilds the dashboard using
  // npm, which requires node_modules to be present in the mounted paths.
  // Running `npm install` here (inside the install container, which is a
  // Linux environment matching what the app container needs) writes Linux
  // node_modules into the host directory so the subsequent `docker compose up`
  // works without requiring Node.js or npm on the host machine.
  //
  // This only runs when the install command is executed inside a container
  // (/.dockerenv present) with a --host-root argument, i.e. the install
  // service in docker-compose.yml. It is skipped when running claros install
  // directly on the host (where npm install is already done).
  if (isContainer && hostRoot !== repoRoot) {
    console.log("  Installing node_modules for compose mounts...");
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("npm", ["ci"], {
        cwd: hostRoot,
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 300000,
      });
      console.log("  node_modules installed");
    } catch (err) {
      console.warn(`  WARNING: npm install failed: ${err.message}`);
      console.warn("  docker compose up may fail. Run 'npm install' in the project directory.");
    }

    console.log("  Building packages for compose mounts...");
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("npm", ["run", "build"], {
        cwd: hostRoot,
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 300000,
      });
      console.log("  Build complete");
    } catch (err) {
      console.warn(`  WARNING: npm run build failed: ${err.message}`);
      console.warn("  docker compose up may fail. Run 'npm run build' in the project directory.");
    }
  }

  // Step 6: Print summary
  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────────┐");
  console.log("  │ Install complete                                        │");
  console.log("  ├─────────────────────────────────────────────────────────┤");
  console.log(`  │ .env:  ${envPath}`);
  console.log("  │");
  console.log("  │ BACK THESE UP (required to decrypt stored credentials   │");
  console.log("  │ and validate unsubscribe links in delivered email):      │");
  console.log(`  │   ENCRYPTION_KEY=${encKey.slice(0, 8)}...`);
  console.log(`  │   UNSUBSCRIBE_SIGNING_KEY=${signKey.slice(0, 8)}...`);
  console.log("  │");
  console.log("  │ Next: docker compose up                                 │");
  console.log("  │ Then: open the claim URL printed to the console           │");
  console.log("  └─────────────────────────────────────────────────────────┘");
  console.log("");
}

function printHelp(subcommand) {
  if (subcommand === "doctor") {
    console.log(`
claros doctor [--url <base_url>] [--session <token>]

Read-only deployment diagnostic. NEVER writes to the database.

Prints a single report covering:
  Deployment  local HEAD commit vs. deployed commit from GET /version.
              MATCH or MISMATCH stated unmissably.
  Database    connection host/db, SSL, migration count and latest migration.
  Transport   resend row counts, decryption status, credential key names,
              and the first 8 hex chars of SHA-256 of webhookSecret.
  Environment for ENCRYPTION_KEY and UNSUBSCRIBE_SIGNING_KEY: the LOCAL
              fingerprint (this machine's env) compared against the CONTAINER
              fingerprint (from GET /v1/diagnostics). MATCH or MISMATCH.
              BASE_URL (local).

Security: no secret, key, credential, or password is printed.
Fingerprints and byte lengths only.

Failures are non-fatal. The command always finishes and prints what it could.

How doctor authenticates to /v1/diagnostics:
  /v1/diagnostics is behind the /v1 session-cookie preHandler. Doctor passes
  the token from --session (or CLAROS_DOCTOR_SESSION env var) as the
  claros_session cookie. Without a token the Environment comparison is skipped.
  To get a token: log in via the browser and copy the claros_session cookie
  value from your browser dev tools, or use claros login-link and visit the
  URL to create a session.

Options:
  --prod              Target PRODUCTION_DATABASE_URL.
                      Refuses localhost and non-https /version URLs.
  --url <base>        Override the URL base for /version and /v1/diagnostics.
                      Set CLAROS_DOCTOR_URL in the environment to persist.
  --session <token>   Session token for GET /v1/diagnostics authentication.
                      Set CLAROS_DOCTOR_SESSION in the environment to persist.

Examples:
  # Local database, no environment comparison:
  node apps/server/bin/claros.mjs doctor

  # Local database with environment comparison (session from browser):
  node apps/server/bin/claros.mjs doctor --session <claros_session_cookie_value>

  # Production database with environment comparison:
  CLAROS_DOCTOR_URL=https://claros.example.com \\
    node apps/server/bin/claros.mjs doctor --prod --session <token>
`);
    return;
  }

  if (subcommand === "login-link") {
    console.log(`
claros login-link <email>

Generate a one-time login URL for the given email address. No running server
or email transport is required. The URL is printed to stdout and expires in
10 minutes.

The user with that email must already exist in the database (created on first
boot via SEED_ADMIN_EMAIL, or via the invite endpoint).

Example:
  claros login-link admin@example.com
  docker compose exec app claros login-link admin@example.com
`);
    return;
  }

  if (subcommand === "setup") {
    console.log(`
claros setup [tenant_slug]

Guided first-run configuration wizard. Walks through:
  1. Postal address (required by CAN-SPAM; blocks all sending if absent)
  2. LLM provider   (required for flow compilation)
  3. Transport      (required to send email)

Shows what is already configured and leaves it in place unless you choose to
replace it. Safe to re-run.

When a step is skipped, the wizard prints what would be blocked and lists the
remaining command at the end so the operator knows exactly what to run next.

Default tenant slug: "default"

Example:
  claros setup
  claros setup my-tenant
  docker compose exec app claros setup
`);
    return;
  }

  if (subcommand === "transport") {
    console.log(`
claros transport set <tenant_slug>
claros transport show <tenant_slug>

Manage the email transport configuration for a tenant.

"transport set" encrypts the provider API key and stores it in the database.
"transport show" displays metadata only; credentials are never shown.

Non-interactive (piped JSON):
  echo '{"provider":"resend","from_email":"hi@co.com","api_key":"re_..."}' \\
    | claros transport set my-tenant

Fields for "transport set":
  provider        Required. One of: resend, ses, smtp
  from_email      Required. Sender address (must be verified with the provider)
  from_name       Optional. Display name in the From: header
  api_key         Required. Provider API key (never shown after write)
  webhook_secret  Optional. For verifying inbound event webhooks
  daily_limit     Optional. Maximum emails per day (blank = provider default)
`);
    return;
  }

  if (subcommand === "llm") {
    console.log(`
claros llm set <tenant_slug>
claros llm show <tenant_slug>

Manage the LLM provider configuration for a tenant.

"llm set" encrypts the API key and stores the full config (key, base URL, model)
in the database. "llm show" displays the provider name only.

Non-interactive (piped JSON):
  echo '{"provider":"openai","api_key":"sk-...","base_url":"https://api.openai.com/v1","model":"gpt-4o"}' \\
    | claros llm set my-tenant

Fields for "llm set":
  provider         Required. One of: openai, anthropic, ollama, custom
  api_key          Required. Provider API key
  base_url         Optional for openai/anthropic/ollama (defaults applied). Required for custom.
                   openai:    https://api.openai.com/v1
                   anthropic: https://api.anthropic.com/v1
                   ollama:    http://localhost:11434/v1
  model            Required. Model identifier (e.g. gpt-4o)
  embedding_model  Optional. Must produce vector(1536). Default: text-embedding-3-small
`);
    return;
  }

  if (subcommand === "postal-address") {
    console.log(`
claros postal-address set <tenant_slug>
claros postal-address show <tenant_slug>

Manage the CAN-SPAM required physical postal address for a tenant.

This address appears in the footer of every outgoing email. The drain stops
sending until it is set.

Non-interactive:
  echo '{"postal_address":"123 Main St, City, ST 12345"}' \\
    | claros postal-address set my-tenant
`);
    return;
  }

  // Default help
  console.log(`
claros - Operator CLI for the Claros lifecycle email engine

Usage:
  claros <command> [options]
  node apps/server/bin/claros.mjs <command> [options]
  docker compose exec app claros <command> [options]

Commands:
  install                      Prepare .env, generate secrets, test DB, run migrations
  doctor [--url <url>]         Read-only deployment diagnostic (commit, DB, transport, env)
  login-link <email>           Generate a one-time login URL (no transport needed)
  setup [tenant_slug]          Guided first-run: postal address, LLM, transport
  transport set <slug>         Write transport credentials
  transport show <slug>        Show active transport config (no credentials)
  llm set <slug>               Write LLM credentials
  llm show <slug>              Show active LLM config (no credentials)
  postal-address set <slug>    Set the CAN-SPAM postal address
  postal-address show <slug>   Show the current postal address
  user list <slug>             List active users for a tenant
  user create <slug>           Create a new user (owner or member)
  user promote <slug> <email>  Promote a user to owner
  help [command]               Show detailed help for a command

Options:
  --prod   Target PRODUCTION_DATABASE_URL. Requires typed confirmation.

Credential input:
  Interactive (TTY): prompts for each field; secrets not echoed.
  Non-interactive (pipe): reads JSON from stdin; confirmation is automatic.

Requires npm run build to have been run (imports from dist/).
`);
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

if (!topCommand || topCommand === "help") {
  const helpTarget = restArgs[0];
  printHelp(helpTarget);
  process.exit(0);
}

const dbUrl = resolveDbUrl();
const dbInfo = parseDbTarget(dbUrl);
const pool = new Pool({ connectionString: dbUrl });
const db = drizzle(pool);

if (topCommand !== "login-link" && topCommand !== "doctor") {
  console.log("");
  console.log("=== Claros CLI ===");
  console.log(`Target:  ${dbInfo.hostPort}/${dbInfo.dbName} [${dbInfo.type}]`);
  if (isProd) console.log("Mode:    PRODUCTION (--prod)");
}

try {
  switch (topCommand) {
    case "doctor": {
      // --url <base_url> overrides the /version target for this run.
      const urlFlagIdx = restArgs.indexOf("--url");
      if (urlFlagIdx >= 0 && restArgs[urlFlagIdx + 1]) {
        process.env.CLAROS_DOCTOR_URL = restArgs[urlFlagIdx + 1];
      }
      // --session <token> supplies the claros_session cookie for GET /v1/diagnostics.
      // Falls back to CLAROS_DOCTOR_SESSION env var.
      const sessionFlagIdx = restArgs.indexOf("--session");
      const sessionToken = (sessionFlagIdx >= 0 && restArgs[sessionFlagIdx + 1])
        ? restArgs[sessionFlagIdx + 1]
        : (process.env.CLAROS_DOCTOR_SESSION ?? null);
      await cmdDoctor(db, dbInfo, sessionToken);
      break;
    }
    case "login-link": {
      const email = restArgs[0];
      if (!email) {
        console.error("\nERROR: claros login-link <email>\n"); process.exit(1);
      }
      await cmdLoginLink(db, email);
      break;
    }
    case "setup": {
      const slug = restArgs[0] ?? "default";
      await cmdSetup(db, slug, dbInfo);
      break;
    }
    case "transport": {
      const [sub, slug] = restArgs;
      if (!sub || !slug) {
        console.error("\nERROR: claros transport set|show <tenant_slug>\n"); process.exit(1);
      }
      if (sub === "set") await transportSet(db, slug, dbInfo);
      else if (sub === "show") await transportShow(db, slug);
      else { console.error(`\nUnknown subcommand: transport ${sub}\n`); process.exit(1); }
      break;
    }
    case "llm": {
      const [sub, slug] = restArgs;
      if (!sub || !slug) {
        console.error("\nERROR: claros llm set|show <tenant_slug>\n"); process.exit(1);
      }
      if (sub === "set") await llmSet(db, slug, dbInfo);
      else if (sub === "show") await llmShow(db, slug);
      else { console.error(`\nUnknown subcommand: llm ${sub}\n`); process.exit(1); }
      break;
    }
    case "postal-address": {
      const [sub, slug] = restArgs;
      if (!sub || !slug) {
        console.error("\nERROR: claros postal-address set|show <tenant_slug>\n"); process.exit(1);
      }
      if (sub === "set") await postalAddressSet(db, slug, dbInfo);
      else if (sub === "show") await postalAddressShow(db, slug);
      else { console.error(`\nUnknown subcommand: postal-address ${sub}\n`); process.exit(1); }
      break;
    }
    case "user": {
      const [sub, slug, extra] = restArgs;
      if (!sub || !slug) {
        console.error("\nERROR: claros user list|create|promote <tenant_slug> [email]\n"); process.exit(1);
      }
      if (sub === "list") await userList(db, slug);
      else if (sub === "create") await userCreate(db, slug, dbInfo);
      else if (sub === "promote") {
        if (!extra) { console.error("\nERROR: claros user promote <tenant_slug> <email>\n"); process.exit(1); }
        await userPromote(db, slug, extra, dbInfo);
      }
      else { console.error(`\nUnknown subcommand: user ${sub}\n`); process.exit(1); }
      break;
    }
    default:
      console.error(`\nUnknown command: "${topCommand}". Run "claros help" for usage.\n`);
      process.exit(1);
  }
} catch (err) {
  console.error(`\nERROR: ${err.message}\n`);
  process.exit(1);
} finally {
  closeLineRl();
  await pool.end();
}
