/**
 * Integration tests for the Claros operator CLI (apps/server/bin/claros.mjs).
 *
 * Tests the unified CLI binary by spawning it as a Node.js subprocess and
 * driving it via stdin.
 *
 * Coverage:
 *   Non-interactive (piped JSON):
 *     - transport set: config is written and verifiable via DB decrypt.
 *     - llm set: config is written and verifiable via DB decrypt.
 *     - postal-address set: address is stored and readable via DB query.
 *     - transport show: returns metadata, never credentials.
 *     - llm show: returns metadata, never credentials.
 *     - postal-address show: returns the stored address.
 *     - login-link: generates a token row in the DB, prints a URL.
 *
 *   Interactive (CLAROS_SETTINGS_INTERACTIVE=1 + scripted piped answers):
 *     - transport set: prompts for each field; Enter accepts defaults for
 *       optional fields; required fields are filled from the scripted input.
 *     - llm set: same.
 *     - postal-address set: prompts for the address.
 *     - setup: guided wizard; covers first-time path and re-run path; skipped
 *       steps report what is still missing.
 *     - Scripted input is terminated by EOF, which closes stdin after the
 *       last answer.
 *
 *   Safety:
 *     - api_key, webhook_secret do not appear anywhere in stdout or stderr.
 *     - Unknown transport provider is rejected with exit code 1.
 *     - Unknown LLM provider is rejected with exit code 1.
 *     - Postal address round-trips: set via CLI, readable via DB query,
 *       and the drain stops returning skippedNoPostalAddress once set.
 *
 * TTY detection:
 *   The CLI uses process.stdin.isTTY || CLAROS_SETTINGS_INTERACTIVE === "1".
 *   Tests set CLAROS_SETTINGS_INTERACTIVE=1 to force interactive mode through
 *   a pipe (a pipe cannot be a real TTY, but we need to cover the prompt path).
 *
 * Shared write path:
 *   transport set and llm set use encrypt() + parseEncryptionKey() from
 *   packages/adapters, same as PUT /v1/settings/transport and PUT /v1/settings/llm.
 *   postal-address set uses the same read-modify-write on tenants.settings
 *   as PATCH /v1/settings/tenant (packages/api/src/routes/settings.ts:582-600).
 *   login-link uses the same token generation as POST /auth/login.
 *   Tests verify this by using the same decrypt() function to read back what
 *   the CLI wrote.
 *
 * Requires:
 *   - Local Postgres (docker compose up postgres).
 *   - npm run build must have been run (CLI imports from dist/).
 *   - DATABASE_URL must be set.
 *   - ENCRYPTION_KEY must be set (or the test sets a known test key).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, and, sql } from "drizzle-orm";
import {
  tenants, users, sessions, transportConfigs, llmConfigs, magicLinkTokens,
} from "@claros/db/schema";
import { decrypt, parseEncryptionKey, encrypt } from "@claros/adapters";
import { buildTenantTransportResolver } from "@claros/worker";
import { processDrainTick, fetchDrainBatchSimple } from "@claros/worker";
import {
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
} from "@claros/db/schema";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI_PATH = resolve(repoRoot, "apps/server/bin/claros.mjs");

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  throw new Error(
    `[claros-cli.test] DATABASE_URL is not set.\n` +
      `This test requires a Postgres connection. Set it in .env:\n` +
      `  DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`,
  );
}

// Test key: 32 all-zero bytes, base64. Never used in production.
const TEST_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const TEST_API_KEY = "re_cli_test_key_do_not_use_in_prod";
const TEST_API_KEY_LLM = "sk_cli_llm_test_key_do_not_use";
const TEST_WEBHOOK_SECRET = "whsec_CLITestSecretAAAAAAAAAAAAAAAAAAAAAAAAA";
const TEST_POSTAL_ADDRESS = "1 CLI Test St, Command Town, CT 10001";
const TEST_SIGNING_KEY = "cli-test-signing-key-do-not-use-in-production";
const TEST_BASE_URL = "http://localhost:3000";
const TEST_LOGIN_EMAIL = "cli-test-owner@claros.test";

const SLUG = "test-cli-settings";

// ---------------------------------------------------------------------------
// Default-tenant state snapshot
//
// "default" is the CLI's own default slug and the most likely collision point
// if a test ever omitted a slug argument. This snapshot captures the state of
// the default tenant's credentials before the suite runs and asserts it is
// byte-for-byte identical after the suite completes.
//
// The check protects against:
//   - A test calling the CLI without an explicit slug (falling back to "default")
//   - A test writing directly to the DB without scoping to testTenantId
//   - Manual debugging that leaves state in "default"
//
// If the default tenant does not exist (fresh install), the snapshot is null
// for all fields and the assertion still holds (null === null).
// ---------------------------------------------------------------------------

interface DefaultTenantSnapshot {
  settings: unknown;
  activeTransportIds: string[];
  activeLlmIds: string[];
}

let defaultTenantSnapshot: DefaultTenantSnapshot | null = null;

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let testTenantId: string;

let savedEncryptionKey: string | undefined;

beforeAll(async () => {
  savedEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_KEY_BASE64;

  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    const inCI = process.env.CI === "true";
    if (inCI) {
      throw new Error(
        `[claros-cli.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[claros-cli.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  // Snapshot the default tenant's state before any test runs.
  // The afterAll assertion verifies this is unchanged.
  defaultTenantSnapshot = await captureDefaultTenantState(db);

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "CLI Settings Test", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;

  // Create a user so login-link tests have a target
  await db.insert(users).values({
    tenantId: testTenantId,
    email: TEST_LOGIN_EMAIL,
    role: "owner",
  });
});

afterAll(async () => {
  if (dbAvailable) {
    // Assert the "default" tenant was not touched by any test.
    // This catches accidental CLI calls without a slug, direct DB writes
    // outside testTenantId scope, and any other cross-tenant pollution.
    if (defaultTenantSnapshot !== null) {
      const after = await captureDefaultTenantState(db);
      expect(after).toEqual(defaultTenantSnapshot);
    }

    await cleanup();
  }
  await pool.end();
  if (savedEncryptionKey !== undefined) {
    process.env.ENCRYPTION_KEY = savedEncryptionKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id = ${testTenantId}::uuid`);
  await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id = ${testTenantId}::uuid`);
  await db.execute(sql`DELETE FROM magic_link_tokens WHERE tenant_id = ${testTenantId}::uuid`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${testTenantId})`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`UPDATE tenants SET settings = NULL WHERE id = ${testTenantId}`);
});

async function captureDefaultTenantState(
  db: ReturnType<typeof drizzle>,
): Promise<DefaultTenantSnapshot> {
  // Read the "default" tenant row. If it does not exist, all fields are null/empty.
  const tenantRows = await db
    .select({ id: tenants.id, settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.slug, "default"))
    .limit(1);

  if (tenantRows.length === 0) {
    return { settings: null, activeTransportIds: [], activeLlmIds: [] };
  }

  const defaultId = tenantRows[0]!.id;

  const tcRows = await db
    .select({ id: transportConfigs.id })
    .from(transportConfigs)
    .where(and(eq(transportConfigs.tenantId, defaultId), eq(transportConfigs.isActive, true)));

  const llmRows = await db
    .select({ id: llmConfigs.id })
    .from(llmConfigs)
    .where(and(eq(llmConfigs.tenantId, defaultId), eq(llmConfigs.isActive, true)));

  return {
    settings: tenantRows[0]!.settings,
    activeTransportIds: tcRows.map((r) => r.id).sort(),
    activeLlmIds: llmRows.map((r) => r.id).sort(),
  };
}

async function cleanup() {
  // Use the same pattern as other test files: parameterized subqueries.
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM transport_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM llm_configs WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM magic_link_tokens WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM lifecycle_transitions WHERE contact_id IN (SELECT id FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG}))`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM scan_checkpoints WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM sessions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM users WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${SLUG})`);
  await db.execute(sql`DELETE FROM tenants WHERE slug = ${SLUG}`);
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the CLI with the given args and stdin content.
 *
 * @param args   Command-line arguments after the script path.
 * @param stdin  Content to write to stdin before closing it.
 * @param env    Extra env vars merged over the test process env.
 */
function runCli(args: string[], stdin: string, env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_PATH, ...args], {
      env: {
        ...process.env,
        DATABASE_URL: TEST_DB_URL,
        ENCRYPTION_KEY: TEST_KEY_BASE64,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.stdin.write(stdin);
    child.stdin.end();

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Drain helpers
// ---------------------------------------------------------------------------

async function insertContact(externalId: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId: testTenantId,
      externalId,
      email: `${externalId}@example.com`,
      lifecycleState: "engaged",
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-20T00:00:00Z"),
    })
    .returning({ id: contacts.id });
  return row!.id;
}

async function insertFlow(name: string): Promise<string> {
  const [row] = await db
    .insert(flows)
    .values({
      tenantId: testTenantId,
      name,
      priority: 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      status: "paused",
      flowClass: "nurture",
      compiledPlan: {
        trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
        steps: [{ order: 1, action_type: "nurture_value", delay: "0d", window_policy: "immediate" }],
      },
    })
    .returning({ id: flows.id });
  return row!.id;
}

async function insertMembership(contactId: string, flowId: string): Promise<string> {
  const [row] = await db
    .insert(flowMemberships)
    .values({
      tenantId: testTenantId,
      contactId,
      flowId,
      currentStep: 1,
      status: "completed",
      enteredAt: new Date("2026-07-20T00:00:00Z"),
      completedAt: new Date("2026-07-20T00:00:00Z"),
      exitReason: "completed",
    })
    .returning({ id: flowMemberships.id });
  return row!.id;
}

async function insertApprovedMessage(contactId: string, flowId: string, membershipId: string): Promise<string> {
  const [row] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId: testTenantId,
      contactId,
      flowId,
      membershipId,
      flowStepOrder: 1,
      status: "approved",
      subject: "CLI settings pipeline test",
      bodyHtml: "<p>Test body</p>",
      bodyText: "Test body",
      approvedAt: new Date("2026-07-20T10:00:00Z"),
    })
    .returning({ id: lifecycleMessages.id });
  return row!.id;
}

// ---------------------------------------------------------------------------
// Tests: non-interactive (piped JSON)
// ---------------------------------------------------------------------------

describe("claros CLI - non-interactive (piped JSON)", () => {
  it("transport set: writes config; DB decrypts to what was written", async () => {
    if (!dbAvailable) return;

    const payload = JSON.stringify({
      provider: "resend",
      from_email: "test@example.com",
      from_name: "Test Sender",
      api_key: TEST_API_KEY,
      webhook_secret: TEST_WEBHOOK_SECRET,
    });

    // Non-interactive: pipe JSON; auto-confirms (no "y" needed)
    const { exitCode, stdout, stderr } = await runCli(
      ["transport", "set", SLUG],
      payload,
    );

    expect(exitCode).toBe(0);

    // Verify the config was written to the DB and decrypts correctly
    const rows = await db.execute<{ config: string }>(sql`
      SELECT config::text AS config
      FROM transport_configs
      WHERE tenant_id = ${testTenantId}::uuid AND is_active = true
      LIMIT 1
    `);
    expect(rows.rows).toHaveLength(1);

    const key = parseEncryptionKey(TEST_KEY_BASE64);
    const creds = JSON.parse(decrypt(rows.rows[0]!.config, key)) as {
      apiKey: string;
      webhookSecret: string;
    };
    expect(creds.apiKey).toBe(TEST_API_KEY);
    expect(creds.webhookSecret).toBe(TEST_WEBHOOK_SECRET);

    // api_key and webhook_secret must not appear anywhere in output
    expect(stdout + stderr).not.toContain(TEST_API_KEY);
    expect(stdout + stderr).not.toContain(TEST_WEBHOOK_SECRET);
  });

  it("llm set: writes config; DB decrypts to what was written", async () => {
    if (!dbAvailable) return;

    const payload = JSON.stringify({
      provider: "openai",
      api_key: TEST_API_KEY_LLM,
      base_url: "https://api.openai.com/v1",
      model: "gpt-4o",
    });

    const { exitCode, stdout, stderr } = await runCli(
      ["llm", "set", SLUG],
      payload,
    );

    expect(exitCode).toBe(0);

    const rows = await db
      .select({ config: llmConfigs.config })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, testTenantId), eq(llmConfigs.isActive, true)))
      .limit(1);
    expect(rows).toHaveLength(1);

    const key = parseEncryptionKey(TEST_KEY_BASE64);
    const creds = JSON.parse(decrypt(rows[0]!.config, key)) as {
      apiKey: string;
      baseUrl: string;
      model: string;
    };
    expect(creds.apiKey).toBe(TEST_API_KEY_LLM);
    expect(creds.baseUrl).toBe("https://api.openai.com/v1");
    expect(creds.model).toBe("gpt-4o");

    // api_key must not appear in output
    expect(stdout + stderr).not.toContain(TEST_API_KEY_LLM);
  });

  it("llm set: omitting base_url for openai applies the default", async () => {
    if (!dbAvailable) return;

    // base_url omitted - the CLI should apply the openai default.
    const payload = JSON.stringify({
      provider: "openai",
      api_key: TEST_API_KEY_LLM,
      model: "gpt-4o",
    });

    const { exitCode } = await runCli(["llm", "set", SLUG], payload);
    expect(exitCode).toBe(0);

    const rows = await db
      .select({ config: llmConfigs.config })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, testTenantId), eq(llmConfigs.isActive, true)))
      .limit(1);
    const key = parseEncryptionKey(TEST_KEY_BASE64);
    const creds = JSON.parse(decrypt(rows[0]!.config, key)) as { baseUrl: string };
    expect(creds.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("postal-address set: stores address, readable from DB", async () => {
    if (!dbAvailable) return;

    const payload = JSON.stringify({ postal_address: TEST_POSTAL_ADDRESS });

    const { exitCode, stdout, stderr } = await runCli(
      ["postal-address", "set", SLUG],
      payload,
    );

    expect(exitCode).toBe(0);

    const rows = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, testTenantId))
      .limit(1);

    const settings = rows[0]!.settings as Record<string, unknown>;
    expect(settings.postal_address).toBe(TEST_POSTAL_ADDRESS);
  });

  it("transport show: returns metadata, never api_key", async () => {
    if (!dbAvailable) return;

    // Insert a config first
    const key = parseEncryptionKey(TEST_KEY_BASE64);
    const encryptedConfig = encrypt(JSON.stringify({ apiKey: TEST_API_KEY }), key);
    await db.execute(sql`
      INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email)
      VALUES (${testTenantId}::uuid, 'resend', ${encryptedConfig}::jsonb, true, 'show@example.com')
    `);

    const { exitCode, stdout, stderr } = await runCli(
      ["transport", "show", SLUG],
      "",
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("resend");
    expect(stdout).toContain("show@example.com");
    expect(stdout + stderr).not.toContain(TEST_API_KEY);
  });

  it("llm show: returns metadata, never api_key", async () => {
    if (!dbAvailable) return;

    const key = parseEncryptionKey(TEST_KEY_BASE64);
    const encryptedConfig = encrypt(
      JSON.stringify({ apiKey: TEST_API_KEY_LLM, baseUrl: "https://api.openai.com/v1", model: "gpt-4o" }),
      key,
    );
    await db
      .insert(llmConfigs)
      .values({ tenantId: testTenantId, provider: "openai", config: encryptedConfig, isActive: true });

    const { exitCode, stdout, stderr } = await runCli(
      ["llm", "show", SLUG],
      "",
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("openai");
    expect(stdout + stderr).not.toContain(TEST_API_KEY_LLM);
  });

  it("postal-address show: returns the stored address", async () => {
    if (!dbAvailable) return;

    await db.execute(sql`
      UPDATE tenants SET settings = ${JSON.stringify({ postal_address: TEST_POSTAL_ADDRESS })}::jsonb
      WHERE id = ${testTenantId}
    `);

    const { exitCode, stdout } = await runCli(
      ["postal-address", "show", SLUG],
      "",
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain(TEST_POSTAL_ADDRESS);
  });

  it("unknown transport provider is rejected with exit code 1", async () => {
    if (!dbAvailable) return;

    const payload = JSON.stringify({
      provider: "mailgun",
      from_email: "test@example.com",
      api_key: TEST_API_KEY,
    });

    const { exitCode, stderr } = await runCli(
      ["transport", "set", SLUG],
      payload,
    );

    expect(exitCode).toBe(1);
    expect(stderr + "").toMatch(/unknown provider|mailgun/i);
  });

  it("unknown LLM provider is rejected with exit code 1", async () => {
    if (!dbAvailable) return;

    const payload = JSON.stringify({
      provider: "cohere",
      api_key: TEST_API_KEY_LLM,
      base_url: "https://api.cohere.ai/v1",
      model: "command",
    });

    const { exitCode, stderr } = await runCli(
      ["llm", "set", SLUG],
      payload,
    );

    expect(exitCode).toBe(1);
    expect(stderr + "").toMatch(/unknown provider|cohere/i);
  });

  it("abort on confirmation writes nothing to the DB (interactive mode)", async () => {
    if (!dbAvailable) return;

    // In interactive mode, answering "n" at the confirmation prompt aborts the write.
    // Field order: provider -> from_email -> from_name -> api_key -> webhook_secret -> daily_limit -> confirm
    const scriptedInput = [
      "resend",
      "abort@example.com",
      "",
      TEST_API_KEY,
      "",
      "",
      "n",  // confirmation: abort
    ].join("\n") + "\n";

    const { exitCode } = await runCli(
      ["transport", "set", SLUG],
      scriptedInput,
      { CLAROS_SETTINGS_INTERACTIVE: "1" },
    );

    expect(exitCode).toBe(0);

    const rows = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt FROM transport_configs WHERE tenant_id = ${testTenantId}::uuid
    `);
    expect(parseInt(rows.rows[0]!.cnt, 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: interactive (CLAROS_SETTINGS_INTERACTIVE=1 + scripted answers)
// ---------------------------------------------------------------------------
//
// Scripted input format: each answer is on its own line. The CLI reads answers
// sequentially, one per field. Secret fields use the same readline interface
// (no echoing), so they are also line-terminated. After all fields are answered,
// the summary confirmation requires "y".
//
// For optional fields with defaults: send an empty line to accept the default.

describe("claros CLI - interactive (scripted input)", () => {
  it("transport set interactive: prompts accepted, config written", async () => {
    if (!dbAvailable) return;

    // Field order for transport set (resend):
    //   provider -> from_email -> from_name -> daily_limit -> api_key -> webhook_secret
    // Optional fields: from_name (empty = skip), daily_limit (empty = skip), webhook_secret (empty = skip)
    // Then confirmation: "y"
    const scriptedInput = [
      "resend",           // provider
      "sender@acme.com",  // from_email
      "Acme Mailer",      // from_name (optional, filled)
      "",                 // daily_limit (optional, skipped)
      TEST_API_KEY,       // api_key (secret)
      "",                 // webhook_secret (optional, skipped)
      "y",                // confirmation
    ].join("\n") + "\n";

    const { exitCode, stdout, stderr } = await runCli(
      ["transport", "set", SLUG],
      scriptedInput,
      { CLAROS_SETTINGS_INTERACTIVE: "1" },
    );

    expect(exitCode).toBe(0);

    // Verify config was written
    const rows = await db.execute<{ from_email: string; config: string }>(sql`
      SELECT from_email, config::text AS config
      FROM transport_configs
      WHERE tenant_id = ${testTenantId}::uuid AND is_active = true
      LIMIT 1
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.from_email).toBe("sender@acme.com");

    const key = parseEncryptionKey(TEST_KEY_BASE64);
    const creds = JSON.parse(decrypt(rows.rows[0]!.config, key)) as { apiKey: string };
    expect(creds.apiKey).toBe(TEST_API_KEY);

    // Secret must not appear in any output
    expect(stdout + stderr).not.toContain(TEST_API_KEY);
  }, 30000);

  it("transport set interactive: required field re-prompts on empty input", async () => {
    if (!dbAvailable) return;

    // For from_email: send an empty line first, then a valid value.
    // The CLI should re-prompt on the empty line.
    const scriptedInput = [
      "resend",           // provider
      "",                 // from_email (empty - should re-prompt)
      "retry@acme.com",   // from_email (second attempt)
      "",                 // from_name (optional, skipped)
      "",                 // daily_limit (optional, skipped)
      TEST_API_KEY,       // api_key (secret)
      "",                 // webhook_secret (optional, skipped)
      "y",                // confirmation
    ].join("\n") + "\n";

    const { exitCode, stdout, stderr } = await runCli(
      ["transport", "set", SLUG],
      scriptedInput,
      { CLAROS_SETTINGS_INTERACTIVE: "1" },
    );

    expect(exitCode).toBe(0);

    const rows = await db.execute<{ from_email: string }>(sql`
      SELECT from_email FROM transport_configs
      WHERE tenant_id = ${testTenantId}::uuid AND is_active = true LIMIT 1
    `);
    expect(rows.rows[0]!.from_email).toBe("retry@acme.com");
  }, 30000);

  it("transport set interactive: unknown provider re-prompts until valid", async () => {
    if (!dbAvailable) return;

    const scriptedInput = [
      "mailgun",          // invalid provider - should re-prompt
      "resend",           // valid provider
      "p@example.com",    // from_email
      "",                 // from_name (optional, skipped)
      "",                 // daily_limit (optional, skipped)
      TEST_API_KEY,       // api_key
      "",                 // webhook_secret
      "y",                // confirmation
    ].join("\n") + "\n";

    const { exitCode, stdout, stderr } = await runCli(
      ["transport", "set", SLUG],
      scriptedInput,
      { CLAROS_SETTINGS_INTERACTIVE: "1" },
    );

    expect(exitCode).toBe(0);

    const rows = await db.execute<{ provider: string }>(sql`
      SELECT provider FROM transport_configs
      WHERE tenant_id = ${testTenantId}::uuid AND is_active = true LIMIT 1
    `);
    expect(rows.rows[0]!.provider).toBe("resend");

    // Error message shown for the invalid provider
    expect(stdout + stderr).toContain("mailgun");
  }, 30000);

  it("llm set interactive: prompts accepted, config written", async () => {
    if (!dbAvailable) return;

    // Field order for llm set:
    //   provider -> api_key -> base_url -> model -> embedding_model (default: text-embedding-3-small)
    // Then confirmation: "y"
    const scriptedInput = [
      "openai",                            // provider
      TEST_API_KEY_LLM,                    // api_key (secret)
      "https://api.openai.com/v1",         // base_url
      "gpt-4o",                            // model
      "",                                  // embedding_model (accept default)
      "y",                                 // confirmation
    ].join("\n") + "\n";

    const { exitCode, stdout, stderr } = await runCli(
      ["llm", "set", SLUG],
      scriptedInput,
      { CLAROS_SETTINGS_INTERACTIVE: "1" },
    );

    expect(exitCode).toBe(0);

    const rows = await db
      .select({ config: llmConfigs.config })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, testTenantId), eq(llmConfigs.isActive, true)))
      .limit(1);
    expect(rows).toHaveLength(1);

    const key = parseEncryptionKey(TEST_KEY_BASE64);
    const creds = JSON.parse(decrypt(rows[0]!.config, key)) as {
      apiKey: string;
      baseUrl: string;
      model: string;
      embedding_model?: string;
    };
    expect(creds.apiKey).toBe(TEST_API_KEY_LLM);
    expect(creds.baseUrl).toBe("https://api.openai.com/v1");
    expect(creds.model).toBe("gpt-4o");
    // Accepting the default embedding_model returns "text-embedding-3-small" which gets stored.
    expect(creds.embedding_model).toBe("text-embedding-3-small");

    // api_key must not appear in output
    expect(stdout + stderr).not.toContain(TEST_API_KEY_LLM);
  }, 30000);

  it("llm set interactive: Enter at base_url accepts provider default", async () => {
    if (!dbAvailable) return;

    // For openai, pressing Enter at base_url should apply https://api.openai.com/v1.
    // Field order: provider -> api_key -> base_url (Enter) -> model -> embedding_model -> confirm
    const scriptedInput = [
      "openai",
      TEST_API_KEY_LLM,
      "",          // base_url: press Enter, expect default applied
      "gpt-4o",
      "",          // embedding_model: default
      "y",
    ].join("\n") + "\n";

    const { exitCode } = await runCli(
      ["llm", "set", SLUG],
      scriptedInput,
      { CLAROS_SETTINGS_INTERACTIVE: "1" },
    );
    expect(exitCode).toBe(0);

    const rows = await db
      .select({ config: llmConfigs.config })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, testTenantId), eq(llmConfigs.isActive, true)))
      .limit(1);
    const key = parseEncryptionKey(TEST_KEY_BASE64);
    const creds = JSON.parse(decrypt(rows[0]!.config, key)) as { baseUrl: string };
    expect(creds.baseUrl).toBe("https://api.openai.com/v1");
  }, 30000);

  it("postal-address set interactive: prompts accepted, address written", async () => {
    if (!dbAvailable) return;

    // Field order: postal_address, then confirmation "y"
    const scriptedInput = [
      TEST_POSTAL_ADDRESS,  // postal_address
      "y",                  // confirmation
    ].join("\n") + "\n";

    const { exitCode } = await runCli(
      ["postal-address", "set", SLUG],
      scriptedInput,
      { CLAROS_SETTINGS_INTERACTIVE: "1" },
    );

    expect(exitCode).toBe(0);

    const rows = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, testTenantId))
      .limit(1);

    const settings = rows[0]!.settings as Record<string, unknown>;
    expect(settings.postal_address).toBe(TEST_POSTAL_ADDRESS);
  }, 30000);

  it("interactive: secrets never appear in stdout or stderr", async () => {
    if (!dbAvailable) return;

    const scriptedInput = [
      "resend",
      "safe@example.com",
      "",
      TEST_API_KEY,
      TEST_WEBHOOK_SECRET,
      "",
      "y",
    ].join("\n") + "\n";

    const { stdout, stderr } = await runCli(
      ["transport", "set", SLUG],
      scriptedInput,
      { CLAROS_SETTINGS_INTERACTIVE: "1" },
    );

    expect(stdout + stderr).not.toContain(TEST_API_KEY);
    expect(stdout + stderr).not.toContain(TEST_WEBHOOK_SECRET);
  }, 30000);

  it("abort on confirmation writes nothing to the DB (interactive mode)", async () => {
    if (!dbAvailable) return;

    // In interactive mode, answering "n" at the confirmation prompt aborts the write.
    // Field order: provider -> from_email -> from_name -> api_key -> webhook_secret -> daily_limit -> confirm
    const scriptedInput = [
      "resend",
      "abort@example.com",
      "",
      TEST_API_KEY,
      "",
      "",
      "n",  // confirmation: abort
    ].join("\n") + "\n";

    const { exitCode } = await runCli(
      ["transport", "set", SLUG],
      scriptedInput,
      { CLAROS_SETTINGS_INTERACTIVE: "1" },
    );

    expect(exitCode).toBe(0);

    const rows = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt FROM transport_configs WHERE tenant_id = ${testTenantId}::uuid
    `);
    expect(parseInt(rows.rows[0]!.cnt, 10)).toBe(0);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Tests: postal address and drain interaction
// ---------------------------------------------------------------------------

describe("claros CLI - postal address and drain", () => {
  it("postal address set via CLI unblocks drain", async () => {
    if (!dbAvailable) return;

    // Insert transport config directly (using the same encrypted format as the CLI)
    const key = parseEncryptionKey(TEST_KEY_BASE64);
    const encryptedConfig = encrypt(JSON.stringify({ apiKey: TEST_API_KEY }), key);
    await db.execute(sql`
      INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email)
      VALUES (${testTenantId}::uuid, 'resend', ${encryptedConfig}::jsonb, true, 'drain@example.com')
    `);

    // Insert an approved message
    const contactId = await insertContact("postal-cli-contact");
    const flowId = await insertFlow("postal-cli-flow");
    const membershipId = await insertMembership(contactId, flowId);
    const messageId = await insertApprovedMessage(contactId, flowId, membershipId);

    // First drain: no postal address - should skip
    const resolver = buildTenantTransportResolver(db);
    const tick1 = await processDrainTick(
      db, new Date("2026-07-21T10:00:00Z"), resolver, fetchDrainBatchSimple,
      50, TEST_BASE_URL, TEST_SIGNING_KEY,
    );
    expect(tick1.skippedNoPostalAddress).toBeGreaterThanOrEqual(1);
    expect(tick1.sent).toBe(0);

    const [before] = await db
      .select({ status: lifecycleMessages.status })
      .from(lifecycleMessages)
      .where(eq(lifecycleMessages.id, messageId));
    expect(before!.status).toBe("approved");

    // Set postal address via CLI
    const payload = JSON.stringify({ postal_address: TEST_POSTAL_ADDRESS });
    const { exitCode } = await runCli(
      ["postal-address", "set", SLUG],
      payload,
    );
    expect(exitCode).toBe(0);

    // Second drain: postal address now present - should send (mocked)
    const mockFetch = async (_url: string, options: RequestInit): Promise<Response> => {
      return new Response(JSON.stringify({ id: "postal-cli-provider-id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const origFetch = global.fetch;
    global.fetch = mockFetch as typeof fetch;
    try {
      const tick2 = await processDrainTick(
        db, new Date("2026-07-21T10:01:00Z"), resolver, fetchDrainBatchSimple,
        50, TEST_BASE_URL, TEST_SIGNING_KEY,
      );
      expect(tick2.skippedNoPostalAddress).toBe(0);
      expect(tick2.sent).toBe(1);

      const [after] = await db
        .select({ status: lifecycleMessages.status })
        .from(lifecycleMessages)
        .where(eq(lifecycleMessages.id, messageId));
      expect(after!.status).toBe("sent");
    } finally {
      global.fetch = origFetch;
    }
  });

  it("postal address set via CLI does not overwrite lifecycle/throttle settings", async () => {
    if (!dbAvailable) return;

    // Pre-set lifecycle and throttle keys in settings (simulating templates having written them)
    await db.execute(sql`
      UPDATE tenants
      SET settings = '{"lifecycle":{"activation_window_days":7},"throttle":{"max_per_week":3}}'::jsonb
      WHERE id = ${testTenantId}
    `);

    const payload = JSON.stringify({ postal_address: TEST_POSTAL_ADDRESS });
    const { exitCode } = await runCli(
      ["postal-address", "set", SLUG],
      payload,
    );
    expect(exitCode).toBe(0);

    const rows = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, testTenantId))
      .limit(1);

    const settings = rows[0]!.settings as Record<string, unknown>;
    // Postal address written
    expect(settings.postal_address).toBe(TEST_POSTAL_ADDRESS);
    // Template keys preserved (same as PATCH /v1/settings/tenant behavior)
    expect((settings.lifecycle as Record<string, unknown>).activation_window_days).toBe(7);
    expect((settings.throttle as Record<string, unknown>).max_per_week).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: shared write path - CLI-written configs are resolved by the resolvers
// ---------------------------------------------------------------------------

describe("claros CLI - shared write path", () => {
  it("transport config written by CLI is resolved by buildTenantTransportResolver", async () => {
    if (!dbAvailable) return;

    const payload = JSON.stringify({
      provider: "resend",
      from_email: "resolver@example.com",
      api_key: TEST_API_KEY,
    });

    const { exitCode } = await runCli(
      ["transport", "set", SLUG],
      payload,
    );
    expect(exitCode).toBe(0);

    const resolver = buildTenantTransportResolver(db);
    const adapter = await resolver(testTenantId);
    expect(adapter).not.toBeNull();
    expect(typeof adapter!.send).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Tests: login-link command
// ---------------------------------------------------------------------------

describe("claros CLI - login-link", () => {
  it("generates a magic_link_tokens row and prints a URL", async () => {
    if (!dbAvailable) return;

    const { exitCode, stdout, stderr } = await runCli(
      ["login-link", TEST_LOGIN_EMAIL],
      "",
    );

    expect(exitCode).toBe(0);

    // Token row was created
    const rows = await db
      .select({ id: magicLinkTokens.id, tokenHash: magicLinkTokens.tokenHash })
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.tenantId, testTenantId))
      .limit(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBeTruthy();
    expect(rows[0]!.tokenHash.length).toBe(64); // SHA-256 hex

    // URL appears in stdout
    expect(stdout).toContain("/auth/verify?token=");
    expect(stdout).toContain(TEST_LOGIN_EMAIL);

    // Token value never appears in output (only the URL which contains it is fine)
    // The raw token is in the URL - that is intentional (it is the login link)
  });

  it("rejects unknown email with exit code 1", async () => {
    if (!dbAvailable) return;

    const { exitCode, stderr } = await runCli(
      ["login-link", "nobody@nowhere.test"],
      "",
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("nobody@nowhere.test");
  });

  it("rejects missing email argument with exit code 1", async () => {
    if (!dbAvailable) return;

    const { exitCode, stderr } = await runCli(["login-link"], "");
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: setup (guided wizard)
// ---------------------------------------------------------------------------
//
// The setup wizard uses interactive prompts. Tests drive it via
// CLAROS_SETTINGS_INTERACTIVE=1 with scripted piped input.
//
// Scripted input for the full wizard (all steps configured, no replacements):
//   Step 1 (postal address not set): <address> then the summary "y"
//   Step 2 (LLM not set): <provider> <api_key> <base_url> <model> <embedding default> then "y"
//   Step 3 (transport not set): <provider> <from_email> <from_name> <api_key> <webhook_secret> then "y"
//
// When a step is already configured, the wizard asks "Replace it? [y/N]"
// and "N" keeps the existing value.
//
// When pressing Enter at the provider prompt for LLM or transport, that step
// is skipped. The wizard reports it as still-missing at the end.

describe("claros CLI - setup wizard", () => {
  // ---------------------------------------------------------------------------
  // Helper: scripted input that fully configures all three steps.
  // Shared by the two first-time-run variants below.
  // ---------------------------------------------------------------------------
  const fullSetupInput = () => [
    // Step 1: postal address
    TEST_POSTAL_ADDRESS, "y",
    // Step 2: LLM
    "openai", TEST_API_KEY_LLM, "https://api.openai.com/v1", "gpt-4o", "", "y",
    // Step 3: transport
    "resend", "setup@example.com", "Setup Test", TEST_API_KEY, "", "y",
  ].join("\n") + "\n";

  // Shared DB assertions for the full-setup case.
  async function assertFullSetupWritten() {
    // Postal address saved
    const tenantRow = await db
      .select({ settings: tenants.settings })
      .from(tenants).where(eq(tenants.id, testTenantId)).limit(1);
    const settings = tenantRow[0]!.settings as Record<string, unknown>;
    expect(settings.postal_address).toBe(TEST_POSTAL_ADDRESS);

    // LLM saved
    const llmRows = await db
      .select({ config: llmConfigs.config })
      .from(llmConfigs)
      .where(and(eq(llmConfigs.tenantId, testTenantId), eq(llmConfigs.isActive, true)))
      .limit(1);
    expect(llmRows).toHaveLength(1);
    const key = parseEncryptionKey(TEST_KEY_BASE64);
    const llmCreds = JSON.parse(decrypt(llmRows[0]!.config, key)) as { apiKey: string };
    expect(llmCreds.apiKey).toBe(TEST_API_KEY_LLM);

    // Transport saved
    const transRows = await db.execute<{ from_email: string }>(sql`
      SELECT from_email FROM transport_configs
      WHERE tenant_id = ${testTenantId}::uuid AND is_active = true LIMIT 1
    `);
    expect(transRows.rows[0]!.from_email).toBe("setup@example.com");
  }

  it("first-time run (signing key present): all three steps configured; summary says 'all done'", async () => {
    if (!dbAvailable) return;

    // UNSUBSCRIBE_SIGNING_KEY is explicitly set to a known value here so this
    // test is not affected by whatever the developer has (or does not have) in
    // their .env. The wizard's summary branch depends on this key being present,
    // so the test must own that variable rather than inheriting it from the
    // ambient environment.
    const { exitCode, stdout, stderr } = await runCli(
      ["setup", SLUG],
      fullSetupInput(),
      {
        CLAROS_SETTINGS_INTERACTIVE: "1",
        UNSUBSCRIBE_SIGNING_KEY: TEST_SIGNING_KEY,
      },
    );

    expect(exitCode).toBe(0);
    await assertFullSetupWritten();

    // Secrets never in output
    expect(stdout + stderr).not.toContain(TEST_API_KEY);
    expect(stdout + stderr).not.toContain(TEST_API_KEY_LLM);

    // Summary says "all done" because signing key is present
    expect(stdout).toContain("All three configuration steps are done");
    expect(stdout).not.toContain("UNSUBSCRIBE_SIGNING_KEY is not set");
  }, 60000);

  it("first-time run (signing key absent): all three steps configured; summary warns about missing key", async () => {
    if (!dbAvailable) return;

    // UNSUBSCRIBE_SIGNING_KEY is explicitly set to empty string here, which
    // the CLI treats as absent (it checks `!!(value ?? "").trim()`). An empty
    // string also prevents the CLI's own .env loader from overriding the value
    // (the loader skips keys already set in the subprocess env, per claros.mjs:94).
    // Without this explicit control, the test passes on machines where the
    // developer has the key in .env and fails on CI where the key is absent.
    const { exitCode, stdout, stderr } = await runCli(
      ["setup", SLUG],
      fullSetupInput(),
      {
        CLAROS_SETTINGS_INTERACTIVE: "1",
        UNSUBSCRIBE_SIGNING_KEY: "",
      },
    );

    expect(exitCode).toBe(0);
    await assertFullSetupWritten();

    // Secrets never in output
    expect(stdout + stderr).not.toContain(TEST_API_KEY);
    expect(stdout + stderr).not.toContain(TEST_API_KEY_LLM);

    // Summary shows the DB steps are done but warns about the missing key
    expect(stdout).toContain("Database configuration steps are done");
    expect(stdout).toContain("UNSUBSCRIBE_SIGNING_KEY is not set");
    // The "all done" line must NOT appear when the key is absent
    expect(stdout).not.toContain("All three configuration steps are done");
  }, 60000);

  it("re-run: existing config shown; operator keeps it (presses N)", async () => {
    if (!dbAvailable) return;

    // Pre-configure everything
    const trimmed = TEST_POSTAL_ADDRESS;
    await db.update(tenants).set({ settings: { postal_address: trimmed } }).where(eq(tenants.id, testTenantId));
    const encKey = parseEncryptionKey(TEST_KEY_BASE64);
    const { encrypt: encFn } = await import("@claros/adapters");
    await db.insert(llmConfigs).values({
      tenantId: testTenantId,
      provider: "openai",
      config: encFn(JSON.stringify({ apiKey: TEST_API_KEY_LLM, baseUrl: "https://api.openai.com/v1", model: "gpt-4o" }), encKey),
      isActive: true,
    });
    await db.execute(sql`
      INSERT INTO transport_configs (tenant_id, provider, config, is_active, from_email)
      VALUES (${testTenantId}::uuid, 'resend', ${encFn(JSON.stringify({ apiKey: TEST_API_KEY }), encKey)}::jsonb, true, 'existing@example.com')
    `);

    // Scripted input: "N" to keep each existing value
    const scriptedInput = [
      "n",  // keep existing postal address
      "n",  // keep existing LLM
      "n",  // keep existing transport
    ].join("\n") + "\n";

    const { exitCode, stdout } = await runCli(
      ["setup", SLUG],
      scriptedInput,
      { CLAROS_SETTINGS_INTERACTIVE: "1" },
    );

    expect(exitCode).toBe(0);

    // Existing config shown in output
    expect(stdout).toContain(TEST_POSTAL_ADDRESS);
    expect(stdout).toContain("openai");
    expect(stdout).toContain("existing@example.com");
    expect(stdout).toContain("Keeping existing");

    // Nothing was changed
    const transAfter = await db.execute<{ from_email: string }>(sql`
      SELECT from_email FROM transport_configs
      WHERE tenant_id = ${testTenantId}::uuid AND is_active = true LIMIT 1
    `);
    expect(transAfter.rows[0]!.from_email).toBe("existing@example.com");
  }, 60000);

  it("skipping a step: reports what is missing at the end", async () => {
    if (!dbAvailable) return;

    // Postal address: provide one
    // LLM: skip (press Enter at provider)
    // Transport: skip (press Enter at provider)
    const scriptedInput = [
      // Step 1: postal address
      TEST_POSTAL_ADDRESS, "y",
      // Step 2: LLM - skip by pressing Enter at provider
      "",
      // Step 3: transport - skip by pressing Enter at provider
      "",
    ].join("\n") + "\n";

    const { exitCode, stdout } = await runCli(
      ["setup", SLUG],
      scriptedInput,
      { CLAROS_SETTINGS_INTERACTIVE: "1" },
    );

    expect(exitCode).toBe(0);

    // LLM and transport should be in "still missing" list
    expect(stdout).toContain("llm set");
    expect(stdout).toContain("transport set");

    // Postal address was saved
    const row = await db
      .select({ settings: tenants.settings })
      .from(tenants).where(eq(tenants.id, testTenantId)).limit(1);
    const settings = row[0]!.settings as Record<string, unknown>;
    expect(settings.postal_address).toBe(TEST_POSTAL_ADDRESS);

    // LLM was NOT saved
    const llmRows = await db
      .select({ id: llmConfigs.id }).from(llmConfigs)
      .where(eq(llmConfigs.tenantId, testTenantId)).limit(1);
    expect(llmRows).toHaveLength(0);
  }, 60000);
});
