/**
 * The commands: deploy, upgrade, products set-host, doctor, claim-url.
 *
 * Every step is an idempotent "ensure": it reads the current state on
 * Cloudflare and changes only what is missing. A second `claros deploy`
 * with nothing to do plans no changes (`--dry-run` lists the plan).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Assets } from "./assets.js";
import { ANY_USER_SQL, claimUrl, mintClaimToken } from "./claim.js";
import { CloudflareApi, isWorkerNotFound, type FetchFn } from "./cloudflare-api.js";
import {
  DEFAULT_INSTANCE,
  INSTANCE_NAME,
  SECRET_NAMES,
  instanceDir,
  loadState,
  newState,
  saveState,
  statePath,
  type InstanceState,
  type SecretName,
  type UpgradeBackup,
} from "./state.js";
import { configHash, generateConfig, renderConfig, type GeneratedConfig } from "./template.js";
import { compareVersions } from "./version.js";
import { Wrangler, WranglerError } from "./wrangler.js";

export const DOCS_URL = "https://github.com/claroshq/claros/blob/main/docs/install/cloudflare.md";

export interface Io {
  log(line?: string): void;
  warn(line: string): void;
  /** Ask a question on the terminal; absent when not interactive. */
  prompt?(question: string): Promise<string>;
}

export interface Context {
  wrangler: Wrangler;
  fetch: FetchFn;
  io: Io;
  configDir: string;
  assets: () => Assets;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  random: (bytes: number) => Buffer;
  /** How long to wait for a deployed version to answer. */
  pollTimeoutMs: number;
  pollIntervalMs: number;
}

export function defaultContextParts(): Pick<Context, "now" | "sleep" | "random" | "pollTimeoutMs" | "pollIntervalMs"> {
  return {
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: (n) => randomBytes(n),
    pollTimeoutMs: 5 * 60 * 1000,
    pollIntervalMs: 3000,
  };
}

/** A bare host name such as "news.example.com" (same rule as the products API). */
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Product slugs (same rule as the products API). */
const SLUG = /^[a-z0-9-]{2,63}$/;

export function normalizeHost(raw: string, what = "host"): string {
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (host.length > 253 || !HOST.test(host)) throw new Error(`Invalid ${what} "${raw}": use a host name like claros.example.com (no scheme, port or path).`);
  return host;
}

function checkName(name: string): string {
  if (!INSTANCE_NAME.test(name)) {
    throw new Error(`Invalid instance name "${name}": lowercase letters, digits and hyphens, at most 40 characters.`);
  }
  return name;
}

/** ENCRYPTION_KEY: 32 bytes base64. UNSUBSCRIBE_SIGNING_KEY: 32 bytes hex. */
export function generateSecret(name: SecretName, random: (n: number) => Buffer): string {
  return name === "ENCRYPTION_KEY" ? random(32).toString("base64") : random(32).toString("hex");
}

// ---------------------------------------------------------------------------
// Session: account, state, bound wrangler
// ---------------------------------------------------------------------------

interface Session {
  state: InstanceState;
  dir: string;
  configPath: string;
  /** Wrangler bound to the account (and, once written, the configuration file). */
  wr: Wrangler;
  api: CloudflareApi;
}

async function selectAccount(
  ctx: Context,
  opts: { account?: string; nonInteractive?: boolean },
  existing: InstanceState | null,
): Promise<string> {
  let me = await ctx.wrangler.whoami();
  if (!me.loggedIn) {
    if (opts.nonInteractive || !ctx.io.prompt) {
      throw new Error("Not logged in to Cloudflare. Run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID).");
    }
    ctx.io.log("Not logged in to Cloudflare; starting `wrangler login`.");
    await ctx.wrangler.login();
    me = await ctx.wrangler.whoami();
    if (!me.loggedIn) throw new Error("Still not logged in to Cloudflare.");
  }
  const wanted = opts.account ?? existing?.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (wanted) {
    const match = me.accounts.find((a) => a.id === wanted || a.name === wanted);
    // An account-scoped API token may not list accounts; trust an explicit id then.
    if (!match && me.accounts.length > 0) {
      throw new Error(`Account "${wanted}" is not one of yours: ${me.accounts.map((a) => `${a.name} (${a.id})`).join(", ")}.`);
    }
    return match?.id ?? wanted;
  }
  if (me.accounts.length === 1) return me.accounts[0]!.id;
  if (me.accounts.length === 0) throw new Error("No Cloudflare account found for these credentials; pass --account <id>.");
  const list = me.accounts.map((a, i) => `  ${i + 1}. ${a.name} (${a.id})`).join("\n");
  if (opts.nonInteractive || !ctx.io.prompt) {
    throw new Error(`Several Cloudflare accounts are available; pass --account <id>:\n${list}`);
  }
  const answer = await ctx.io.prompt(`Cloudflare accounts:\n${list}\nDeploy to which one? [1-${me.accounts.length}] `);
  const picked = me.accounts[Number(answer.trim()) - 1];
  if (!picked) throw new Error(`No account number ${answer.trim()}.`);
  return picked.id;
}

function openSession(ctx: Context, state: InstanceState): Session {
  const dir = instanceDir(ctx.configDir, state.name);
  const configPath = join(dir, "wrangler.jsonc");
  const wr = ctx.wrangler.with({ accountId: state.accountId, cwd: dir, configPath });
  const api = new CloudflareApi(ctx.fetch, () => wr.authToken());
  return { state, dir, configPath, wr, api };
}

/** A session for an instance that was deployed before (state file required). */
async function existingSession(ctx: Context, name: string, opts: { account?: string; nonInteractive?: boolean }): Promise<Session> {
  checkName(name);
  const state = loadState(ctx.configDir, name);
  if (!state) {
    throw new Error(
      `No local state for instance "${name}" (${statePath(ctx.configDir, name)}). ` +
        "Run `npx @claroshq/claros deploy` (with the same --name and --domain): it finds the existing resources by name.",
    );
  }
  const accountId = await selectAccount(ctx, opts, state);
  if (accountId !== state.accountId) throw new Error(`Instance "${name}" lives in account ${state.accountId}, not ${accountId}.`);
  return openSession(ctx, state);
}

function writeConfig(s: Session, config: GeneratedConfig): void {
  writeFileSync(s.configPath, renderConfig(config), { mode: 0o600 });
}

/** Product public hosts from D1 (none before the first migration). */
export const PRODUCT_HOSTS_SQL =
  "SELECT public_host FROM tenants WHERE public_host IS NOT NULL AND archived_at IS NULL ORDER BY public_host";

async function productHosts(s: Session): Promise<string[]> {
  try {
    const [rows = []] = await s.wr.d1Execute(PRODUCT_HOSTS_SQL);
    return rows.map((r) => String(r.public_host)).filter((h) => HOST.test(h));
  } catch (err) {
    if (err instanceof WranglerError && /no such table/i.test(err.output)) return [];
    throw err;
  }
}

/** Generate and write the configuration with the current product hosts. */
async function currentConfig(ctx: Context, s: Session): Promise<GeneratedConfig> {
  // The D1 binding has to be in the file before d1 execute can read the hosts.
  writeConfig(s, generateConfig({ state: s.state, assets: ctx.assets(), productHosts: [] }));
  const config = generateConfig({ state: s.state, assets: ctx.assets(), productHosts: await productHosts(s) });
  writeConfig(s, config);
  return config;
}

// ---------------------------------------------------------------------------
// Deploy the Worker (custom domain check, secrets, workers.dev host, poll)
// ---------------------------------------------------------------------------

function conflictMessage(conflicts: Awaited<ReturnType<CloudflareApi["domainConflicts"]>>): string {
  const lines = conflicts.map((c) =>
    c.kind === "dns_record"
      ? `  - ${c.hostname}: a DNS record for this host already exists in its zone`
      : `  - ${c.hostname}: already a custom domain of the Worker "${c.service}"`,
  );
  return [
    "Stopped before deploying: these hosts are in use, and Claros does not change DNS records or other Workers' domains:",
    ...lines,
    "Remove or rename the record (Cloudflare dashboard > the zone > DNS > Records), or use another host, then run the command again.",
  ].join("\n");
}

async function deployWorker(
  ctx: Context,
  s: Session,
  config: GeneratedConfig,
  secrets: Partial<Record<SecretName, string>>,
): Promise<void> {
  const version = ctx.assets().version;
  const secretsFile = join(s.dir, ".secrets.json");
  let pendingSecrets = { ...secrets };
  const deployOnce = async (cfg: GeneratedConfig) => {
    writeConfig(s, cfg);
    const hasSecrets = Object.keys(pendingSecrets).length > 0;
    if (hasSecrets) writeFileSync(secretsFile, JSON.stringify(pendingSecrets), { mode: 0o600 });
    try {
      const result = await s.wr.deploy(hasSecrets ? { secretsFile } : {});
      pendingSecrets = {};
      return result;
    } finally {
      if (hasSecrets) rmSync(secretsFile, { force: true });
    }
  };

  const hosts = config.routes.map((r) => r.pattern);
  if (hosts.length > 0) {
    let conflicts;
    try {
      conflicts = await s.api.domainConflicts(s.state.accountId, s.state.workerName, hosts);
    } catch (err) {
      if (!isWorkerNotFound(err)) throw err;
      // New Worker: create it without custom domains, then check them.
      ctx.io.log(`Creating the Worker ${s.state.workerName} (custom domains are attached after a conflict check).`);
      await deployOnce(generateConfig({ state: s.state, assets: ctx.assets(), productHosts: [], withoutRoutes: true }));
      conflicts = await s.api.domainConflicts(s.state.accountId, s.state.workerName, hosts);
    }
    if (conflicts.length > 0) {
      writeConfig(s, config);
      throw new Error(conflictMessage(conflicts));
    }
  }

  ctx.io.log(`Deploying ${s.state.workerName} (Claros ${version}).`);
  let result = await deployOnce(config);
  let deployed = config;

  // workers.dev install: the host is known only after the first deploy.
  if (!s.state.host) {
    const dev = result.urls.map((u) => new URL(u).hostname).find((h) => h.endsWith(".workers.dev"));
    if (dev) {
      s.state.host = dev;
      deployed = generateConfig({ state: s.state, assets: ctx.assets(), productHosts: hosts });
      ctx.io.log(`Setting BASE_URL to https://${dev} and deploying again.`);
      result = await deployOnce(deployed);
    } else {
      ctx.io.warn("Could not read the workers.dev URL from wrangler's output; BASE_URL is not set, so sending stays blocked. Run `npx @claroshq/claros deploy --domain <host>`.");
    }
  }

  s.state.versionId = result.versionId ?? s.state.versionId;
  s.state.deployedVersion = version;
  s.state.configHash = configHash(deployed);
  saveState(ctx.configDir, s.state);
}

/** Wait until https://<host>/version reports the version. */
export async function pollVersion(ctx: Context, host: string, version: string): Promise<boolean> {
  const deadline = ctx.now().getTime() + ctx.pollTimeoutMs;
  for (;;) {
    try {
      const res = await ctx.fetch(`https://${host}/version`, { headers: { accept: "application/json" } });
      if (res.ok) {
        const body = (await res.json()) as { version?: string };
        if (body.version === version) return true;
      }
    } catch {
      // DNS or certificate not ready yet.
    }
    if (ctx.now().getTime() >= deadline) return false;
    await ctx.sleep(ctx.pollIntervalMs);
  }
}

async function anyUserExists(s: Session): Promise<boolean> {
  const [rows = []] = await s.wr.d1Execute(ANY_USER_SQL);
  return Number(rows[0]?.any_user ?? 0) === 1;
}

/** Mint a claim token when no user exists; returns the URL or null. */
async function claimIfUnclaimed(ctx: Context, s: Session): Promise<string | null> {
  if (await anyUserExists(s)) return null;
  const minted = mintClaimToken(ctx.now(), ctx.random(32).toString("base64url"));
  await s.wr.d1Execute(minted.sql);
  return claimUrl(s.state.host ?? "<your-worker-host>", minted.token);
}

function printClaim(ctx: Context, url: string): void {
  ctx.io.log("");
  ctx.io.log("Claim your account (one-time link, valid for 24 hours):");
  ctx.io.log(`  ${url}`);
  ctx.io.log("A new link: `npx @claroshq/claros claim-url`.");
}

async function planWarning(ctx: Context, s: Session): Promise<void> {
  if ((await s.api.workersPlan(s.state.accountId)) === "paid") return;
  ctx.io.warn(
    [
      "Could not confirm a Workers Paid plan on this account. On Workers Free:",
      "  - D1 and Queues have daily limits; queries fail once a daily D1 limit is reached until it resets (00:00 UTC).",
      "  - Cloudflare Email Service can send to arbitrary recipients only on Workers Paid.",
      "  Limits: https://developers.cloudflare.com/d1/platform/limits/ and https://developers.cloudflare.com/queues/platform/limits/",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// claros deploy
// ---------------------------------------------------------------------------

export interface DeployOptions {
  name?: string;
  domain?: string;
  account?: string;
  nonInteractive?: boolean;
  /** Only list what would change. */
  dryRun?: boolean;
  /** Deploy the Worker even when nothing changed. */
  force?: boolean;
}

export interface DeployOutcome {
  /** What was changed (or, with dryRun, would be). Empty: nothing to do. */
  changes: string[];
  state: InstanceState;
  claimUrl: string | null;
}

export async function deploy(ctx: Context, opts: DeployOptions): Promise<DeployOutcome> {
  const name = checkName(opts.name ?? DEFAULT_INSTANCE);
  const domain = opts.domain ? normalizeHost(opts.domain, "--domain") : undefined;
  const dryRun = Boolean(opts.dryRun);
  const changes: string[] = [];
  const act = async (what: string, fn: () => Promise<void>) => {
    changes.push(what);
    if (!dryRun) await fn();
  };

  // 1-2. Account and state.
  const existing = loadState(ctx.configDir, name);
  const accountId = await selectAccount(ctx, opts, existing);
  if (existing && existing.accountId !== accountId) {
    throw new Error(`Instance "${name}" lives in account ${existing.accountId}, not ${accountId}. Use another --name for a second instance.`);
  }
  const state: InstanceState = existing ?? newState(name, accountId);
  const s = openSession(ctx, state);
  ctx.io.log(`Instance "${name}" in account ${accountId}${dryRun ? " (dry run)" : ""}.`);
  await planWarning(ctx, s);

  // 3. D1 and queues.
  const findDb = async () => (await s.wr.d1List()).find((d) => d.name === state.d1Name);
  let db = await findDb();
  if (!db) {
    await act(`create D1 database ${state.d1Name}`, async () => {
      await s.wr.d1Create(state.d1Name);
      db = await findDb();
      if (!db) throw new Error(`D1 database ${state.d1Name} was created but is not listed yet; run the command again.`);
    });
  }
  for (const queue of [state.queues.jobs, state.queues.dlq]) {
    if (!(await s.wr.queueExists(queue))) await act(`create queue ${queue}`, () => s.wr.queueCreate(queue));
  }
  if (domain && (state.host !== domain || !state.customDomain)) {
    changes.push(`serve the instance on https://${domain}`);
    state.host = domain;
    state.customDomain = true;
  }
  if (!db) {
    // Dry run against a new install: everything below is new too.
    changes.push("set secrets ENCRYPTION_KEY and UNSUBSCRIBE_SIGNING_KEY", "apply D1 migrations", "deploy the Worker");
    return { changes, state, claimUrl: null };
  }
  state.d1Id = db.uuid;

  // 4. Configuration (routes include product public hosts from D1).
  const config = await currentConfig(ctx, s);

  // 5. Secrets: generate and set only the missing ones; never overwrite.
  const present = await s.wr.secretNames();
  const workerExists = present !== null;
  const newSecrets: Partial<Record<SecretName, string>> = {};
  for (const secret of SECRET_NAMES) {
    if (present?.includes(secret)) continue;
    changes.push(`set secret ${secret}`);
    newSecrets[secret] = state.generatedSecrets[secret] ?? generateSecret(secret, ctx.random);
  }
  if (!dryRun && Object.keys(newSecrets).length > 0) {
    Object.assign(state.generatedSecrets, newSecrets);
    const path = saveState(ctx.configDir, state);
    ctx.io.log(`Generated ${Object.keys(newSecrets).join(" and ")}; saved in ${path} (mode 600). Back this file up:`);
    ctx.io.log("  losing UNSUBSCRIBE_SIGNING_KEY breaks unsubscribe links in mail already sent, losing ENCRYPTION_KEY loses stored credentials.");
  }

  // 6. Migrations.
  const pending = await s.wr.migrationsPending();
  if (pending.length > 0) await act(`apply ${pending.length} D1 migration(s): ${pending.join(", ")}`, () => s.wr.migrationsApply());

  // 7. Deploy when anything changed.
  const version = ctx.assets().version;
  const needsDeploy =
    opts.force ||
    !workerExists ||
    Object.keys(newSecrets).length > 0 ||
    state.configHash !== configHash(config) ||
    state.deployedVersion !== version;
  if (needsDeploy) {
    await act(workerExists ? `deploy the Worker (Claros ${version})` : `create the Worker ${state.workerName} (Claros ${version})`, async () => {
      await deployWorker(ctx, s, config, newSecrets);
      ctx.io.log(`Waiting for https://${state.host}/version to report ${version}.`);
      if (!(await pollVersion(ctx, state.host!, version))) {
        ctx.io.warn(`https://${state.host} does not answer with ${version} yet. New custom domains can take a few minutes (certificate). Check with \`npx @claroshq/claros doctor --name ${name}\`.`);
      }
    });
  }
  if (!dryRun) saveState(ctx.configDir, state);

  if (dryRun) {
    ctx.io.log(changes.length ? `Planned changes:\n${changes.map((c) => `  - ${c}`).join("\n")}` : "No changes.");
    return { changes, state, claimUrl: null };
  }

  // 8. Claim.
  const url = await claimIfUnclaimed(ctx, s);
  if (url) printClaim(ctx, url);

  // 9. Next steps.
  ctx.io.log("");
  ctx.io.log(changes.length ? `Done: ${changes.join("; ")}.` : "Nothing to change; the instance is up to date.");
  ctx.io.log(`Dashboard: https://${state.host}`);
  ctx.io.log("Next steps:");
  ctx.io.log("  - Email transport: Settings > Transport in the dashboard.");
  ctx.io.log(`  - Resend delivery events: add a webhook in Resend to https://${state.host}/webhooks/resend/<product id> (shown in Settings > Transport) and store its signing secret there.`);
  ctx.io.log(`  - Docs: ${DOCS_URL}`);
  return { changes, state, claimUrl: url };
}

// ---------------------------------------------------------------------------
// claros upgrade
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  name?: string;
  account?: string;
  nonInteractive?: boolean;
}

async function liveVersion(ctx: Context, host: string): Promise<string | null> {
  try {
    const res = await ctx.fetch(`https://${host}/version`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return ((await res.json()) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** The command that restores D1 to a Time Travel bookmark. */
export function restoreCommand(d1Name: string, bookmark: string): string {
  return `npx wrangler d1 time-travel restore ${d1Name} --bookmark ${bookmark}`;
}

/**
 * Back up D1 right before migrating: a Time Travel bookmark (the primary
 * backup, it covers every table including the FTS5 index) and an SQL export
 * of the regular tables (`d1 export` refuses virtual tables). Either one is
 * enough to go on; without both the upgrade stops before migrating.
 */
async function backupD1(ctx: Context, s: Session, from: string | null, to: string): Promise<UpgradeBackup> {
  const { state } = s;
  const backups = join(s.dir, "backups");
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const takenAt = ctx.now().toISOString();
  const errors: string[] = [];

  let bookmark: string | null = null;
  try {
    bookmark = await s.wr.d1Bookmark();
    ctx.io.log(`D1 Time Travel bookmark before the upgrade: ${bookmark} (${takenAt}).`);
    ctx.io.log(`  Restore with: ${restoreCommand(state.d1Name, bookmark)}`);
  } catch (err) {
    errors.push(`Time Travel bookmark: ${(err as Error).message}`);
    ctx.io.warn(`Could not read a D1 Time Travel bookmark: ${(err as Error).message}`);
  }

  let sqlFile: string | null = join(backups, `${takenAt.replace(/[:.]/g, "-")}-${from ?? "unknown"}.sql`);
  try {
    const tables = await s.wr.d1ExportableTables();
    ctx.io.log(`Exporting ${tables.length} D1 table(s) to ${sqlFile} (the knowledge-base search index is rebuilt after a restore, not exported).`);
    await s.wr.d1Export(sqlFile, tables);
  } catch (err) {
    errors.push(`SQL export: ${(err as Error).message}`);
    rmSync(sqlFile, { force: true });
    sqlFile = null;
    if (bookmark) ctx.io.warn(`The SQL export of D1 failed; going on with the Time Travel bookmark as the backup. ${(err as Error).message}`);
  }

  if (!bookmark && !sqlFile) {
    throw new Error(`Stopped before migrating: could not back up D1 (no Time Travel bookmark and no SQL export).\n${errors.join("\n")}`);
  }
  const backup: UpgradeBackup = { takenAt, fromVersion: from, toVersion: to, bookmark, sqlFile };
  state.lastUpgradeBackup = backup;
  saveState(ctx.configDir, state);
  return backup;
}

export async function upgrade(
  ctx: Context,
  opts: UpgradeOptions,
): Promise<{ upgraded: boolean; backup: string | null; bookmark: string | null }> {
  const name = opts.name ?? DEFAULT_INSTANCE;
  const s = await existingSession(ctx, name, opts);
  const { state } = s;
  const target = ctx.assets().version;
  if (!state.host || !state.d1Id) throw new Error(`Instance "${name}" was not deployed completely; run \`npx @claroshq/claros deploy --name ${name}\` first.`);

  const running = (await liveVersion(ctx, state.host)) ?? state.deployedVersion;
  if (running && compareVersions(target, running) < 0) {
    throw new Error(`Refusing to downgrade "${name}" from ${running} to ${target}. Use \`npx @claroshq/claros@${running} upgrade\` or newer.`);
  }
  if (running === target && state.deployedVersion === target) {
    ctx.io.log(`"${name}" already runs Claros ${target}.`);
    return { upgraded: false, backup: null, bookmark: null };
  }

  const config = await currentConfig(ctx, s);
  const backup = await backupD1(ctx, s, running, target);

  const pending = await s.wr.migrationsPending();
  if (pending.length > 0) {
    ctx.io.log(`Applying ${pending.length} D1 migration(s): ${pending.join(", ")}.`);
    await s.wr.migrationsApply();
  }

  const previousVersionId = state.versionId;
  let ok = false;
  try {
    await deployWorker(ctx, s, config, {});
    ctx.io.log(`Waiting for https://${state.host}/version to report ${target}.`);
    ok = await pollVersion(ctx, state.host, target);
    if (!ok) ctx.io.warn(`https://${state.host} did not report ${target} in time.`);
  } catch (err) {
    ctx.io.warn(`Deploy failed: ${(err as Error).message}`);
  }
  if (!ok) {
    ctx.io.warn("Rolling the Worker back to the previous version. D1 migrations are not rolled back (they are additive).");
    ctx.io.warn(`D1 backups taken before the upgrade (${backup.takenAt}):`);
    if (backup.bookmark) ctx.io.warn(`  Time Travel: ${restoreCommand(state.d1Name, backup.bookmark)}`);
    if (backup.sqlFile) ctx.io.warn(`  SQL export (without the knowledge-base search index): ${backup.sqlFile}`);
    await s.wr.rollback(previousVersionId, `claros upgrade to ${target} failed`);
    state.versionId = previousVersionId;
    state.deployedVersion = running;
    state.configHash = null;
    saveState(ctx.configDir, state);
    throw new Error(`Upgrade to ${target} failed and was rolled back.`);
  }
  ctx.io.log(`"${name}" now runs Claros ${target}.`);
  return { upgraded: true, backup: backup.sqlFile, bookmark: backup.bookmark };
}

// ---------------------------------------------------------------------------
// claros products set-host
// ---------------------------------------------------------------------------

export async function setProductHost(
  ctx: Context,
  opts: { name?: string; slug: string; host: string; account?: string; nonInteractive?: boolean },
): Promise<void> {
  const name = opts.name ?? DEFAULT_INSTANCE;
  if (!SLUG.test(opts.slug)) throw new Error(`Invalid product slug "${opts.slug}".`);
  const host = normalizeHost(opts.host);
  const s = await existingSession(ctx, name, opts);
  if (host === s.state.host) throw new Error(`${host} is the instance host; a product needs its own host.`);
  writeConfig(s, generateConfig({ state: s.state, assets: ctx.assets(), productHosts: [] }));

  // Slug and host are validated above (no quotes possible).
  const [rows = []] = await s.wr.d1Execute(`SELECT id, public_host FROM tenants WHERE slug = '${opts.slug}'`);
  if (rows.length === 0) throw new Error(`No product with slug "${opts.slug}".`);
  const [taken = []] = await s.wr.d1Execute(`SELECT slug FROM tenants WHERE public_host = '${host}' AND slug <> '${opts.slug}'`);
  if (taken.length > 0) throw new Error(`${host} is already the public host of product "${String(taken[0]!.slug)}".`);
  if (rows[0]!.public_host !== host) {
    await s.wr.d1Execute(`UPDATE tenants SET public_host = '${host}' WHERE slug = '${opts.slug}'`);
    ctx.io.log(`Product "${opts.slug}" now uses https://${host} for links in its mail.`);
  }

  const config = await currentConfig(ctx, s);
  if (s.state.configHash === configHash(config)) {
    ctx.io.log("Routes are up to date.");
    return;
  }
  await deployWorker(ctx, s, config, {});
  ctx.io.log(`Deployed with a custom domain route for ${host}.`);
}

// ---------------------------------------------------------------------------
// claros doctor
// ---------------------------------------------------------------------------

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function doctor(ctx: Context, opts: { name?: string; account?: string; nonInteractive?: boolean }): Promise<Check[]> {
  const name = opts.name ?? DEFAULT_INSTANCE;
  const s = await existingSession(ctx, name, opts);
  const { state } = s;
  const checks: Check[] = [];
  const add = (c: Check) => {
    checks.push(c);
    ctx.io.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  };
  const config = await currentConfig(ctx, s).catch((err: Error) => {
    add({ name: "D1", ok: false, detail: err.message.split("\n")[0]! });
    return null;
  });

  const secrets = await s.wr.secretNames().catch(() => null);
  const missing = SECRET_NAMES.filter((n) => !secrets?.includes(n));
  add({
    name: "secrets",
    ok: secrets !== null && missing.length === 0,
    detail: secrets === null ? "Worker not found" : missing.length ? `missing ${missing.join(", ")}` : SECRET_NAMES.join(", "),
  });

  const pending = await s.wr.migrationsPending().catch((err: Error) => {
    add({ name: "migrations", ok: false, detail: err.message.split("\n")[0]! });
    return null;
  });
  if (pending) add({ name: "migrations", ok: pending.length === 0, detail: pending.length ? `pending: ${pending.join(", ")}` : "all applied" });

  const hosts = [...new Set([state.host, ...(config?.routes.map((r) => r.pattern) ?? [])].filter((h): h is string => Boolean(h)))];
  for (const host of hosts) {
    try {
      const res = await ctx.fetch(`https://${host}/health`, { headers: { accept: "application/json" } });
      const body = res.ok ? ((await res.json()) as { status?: string }) : null;
      add({ name: `https://${host}/health`, ok: body?.status === "ok", detail: res.ok ? `status ${body?.status}` : `HTTP ${res.status}` });
    } catch (err) {
      add({ name: `https://${host}/health`, ok: false, detail: `not reachable over HTTPS (${(err as Error).message})` });
    }
  }
  if (state.host) {
    const live = await liveVersion(ctx, state.host);
    add({
      name: "version",
      ok: live !== null && live === state.deployedVersion,
      detail: live === null ? "/version did not answer with a version" : `running ${live}, last deployed ${state.deployedVersion ?? "unknown"}`,
    });
  }
  ctx.io.log("info cron: Claros does not record cron runs yet; see the Worker's logs (`npx wrangler tail`) or Workers observability.");
  return checks;
}

// ---------------------------------------------------------------------------
// claros claim-url
// ---------------------------------------------------------------------------

export async function claimUrlCommand(ctx: Context, opts: { name?: string; account?: string; nonInteractive?: boolean }): Promise<string | null> {
  const name = opts.name ?? DEFAULT_INSTANCE;
  const s = await existingSession(ctx, name, opts);
  await currentConfig(ctx, s);
  const url = await claimIfUnclaimed(ctx, s);
  if (url) printClaim(ctx, url);
  else ctx.io.log(`"${name}" is already claimed; sign in at https://${s.state.host}/login.`);
  return url;
}
