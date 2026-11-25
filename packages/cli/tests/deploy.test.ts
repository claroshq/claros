/**
 * claros deploy / upgrade / products set-host / doctor / claim-url against a
 * fake Cloudflare account (tests/support/fake-cloudflare.ts). Nothing here
 * talks to Cloudflare.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claimUrlCommand, deploy, doctor, setProductHost, upgrade } from "../src/ops.js";
import { hashClaimToken } from "../src/claim.js";
import { loadState, statePath } from "../src/state.js";
import { deployedConfig, testEnv } from "./support/context.js";

const DOMAIN = "claros.example.com";

describe("claros deploy: fresh install with a custom domain", () => {
  it("creates D1, queues, secrets, applies migrations, deploys, and prints a claim URL", async () => {
    const env = testEnv();
    const out = await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });

    expect(env.cf.d1.has("claros-default")).toBe(true);
    expect([...env.cf.queues].sort()).toEqual(["claros-default-jobs", "claros-default-jobs-dlq"]);
    expect(env.cf.applied.size).toBe(env.cf.migrations.length);

    const worker = env.cf.workers.get("claros-default")!;
    expect(worker.secrets.get("ENCRYPTION_KEY")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(worker.secrets.get("ENCRYPTION_KEY")!, "base64")).toHaveLength(32);
    expect(worker.secrets.get("UNSUBSCRIBE_SIGNING_KEY")).toMatch(/^[0-9a-f]{64}$/);
    expect(worker.secrets.has("RESEND_WEBHOOK_SECRET")).toBe(false);

    const config = deployedConfig(env);
    expect(config.routes).toEqual([{ pattern: DOMAIN, custom_domain: true }]);
    expect(config.workers_dev).toBe(false);
    expect(config.vars).toEqual({ BASE_URL: `https://${DOMAIN}`, CLAROS_VERSION: "0.8.0" });
    expect(config.d1_databases[0]).toMatchObject({ binding: "DB", database_name: "claros-default", database_id: env.cf.d1.get("claros-default") });

    // State: mode 600, generated secrets kept for backup, ids cached.
    const path = statePath(env.configDir, "default");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const state = loadState(env.configDir, "default")!;
    expect(state).toMatchObject({
      accountId: "acc-1",
      d1Id: env.cf.d1.get("claros-default"),
      host: DOMAIN,
      customDomain: true,
      deployedVersion: "0.8.0",
      versionId: worker.active,
    });
    expect(state.generatedSecrets).toEqual({
      ENCRYPTION_KEY: worker.secrets.get("ENCRYPTION_KEY"),
      UNSUBSCRIBE_SIGNING_KEY: worker.secrets.get("UNSUBSCRIBE_SIGNING_KEY"),
    });
    // The temporary secrets file is gone.
    expect(existsSync(join(env.configDir, "default", ".secrets.json"))).toBe(false);
    expect(env.logs.join("\n")).toMatch(/Back this file up/);

    // Claim: the URL's token hashes to what was written to claim_tokens.
    expect(out.claimUrl).toMatch(new RegExp(`^https://${DOMAIN}/claim\\?token=[A-Za-z0-9_-]{43}$`));
    const token = new URL(out.claimUrl!).searchParams.get("token")!;
    expect(env.cf.claimSql).toHaveLength(1);
    expect(env.cf.claimSql[0]).toContain(`'${hashClaimToken(token)}'`);
    expect(env.cf.claimSql[0]).not.toContain(token);
    expect(env.cf.claimSql[0]).toMatch(/^DELETE FROM claim_tokens WHERE consumed_at IS NULL; INSERT INTO claim_tokens/);
    expect(env.logs.join("\n")).toContain(`https://${DOMAIN}/webhooks/resend/`);
  });

  it("a second run plans no changes and changes nothing", async () => {
    const env = testEnv();
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.anyUser = true; // claimed in between
    env.cf.resetCalls();

    const second = await deploy(env.ctx, { nonInteractive: true });
    expect(second.changes).toEqual([]);
    expect(env.cf.mutating()).toEqual([]);
    expect(second.claimUrl).toBeNull();

    const dry = await deploy(env.ctx, { nonInteractive: true, dryRun: true });
    expect(dry.changes).toEqual([]);
  });

  it("works without the local state cache: everything is found again by name", async () => {
    const env = testEnv();
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.anyUser = true;
    const secretsBefore = new Map(env.cf.workers.get("claros-default")!.secrets);

    const fresh = testEnv({ cf: env.cf }); // new, empty config dir
    env.cf.resetCalls();
    const out = await deploy(fresh.ctx, { domain: DOMAIN, nonInteractive: true });
    // Only a redeploy (the new cache has no config hash); no resource or secret is recreated.
    expect(out.changes).toEqual([`serve the instance on https://${DOMAIN}`, "deploy the Worker (Claros 0.8.0)"]);
    expect(env.cf.mutating().every((c) => c.startsWith("deploy"))).toBe(true);
    expect(env.cf.workers.get("claros-default")!.secrets).toEqual(secretsBefore);
  });

  it("dry run on a new install lists the plan and changes nothing", async () => {
    const env = testEnv();
    const out = await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true, dryRun: true });
    expect(env.cf.mutating()).toEqual([]);
    expect(out.changes).toEqual([
      "create D1 database claros-default",
      "create queue claros-default-jobs",
      "create queue claros-default-jobs-dlq",
      `serve the instance on https://${DOMAIN}`,
      "set secrets ENCRYPTION_KEY and UNSUBSCRIBE_SIGNING_KEY",
      "apply D1 migrations",
      "deploy the Worker",
    ]);
    expect(existsSync(statePath(env.configDir, "default"))).toBe(false);
  });
});

describe("claros deploy: secrets", () => {
  it("never overwrites an existing secret; only the missing one is generated", async () => {
    const env = testEnv();
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    const worker = env.cf.workers.get("claros-default")!;
    worker.secrets.delete("UNSUBSCRIBE_SIGNING_KEY");
    worker.secrets.set("ENCRYPTION_KEY", "operator-set-value");
    env.cf.anyUser = true;

    const out = await deploy(env.ctx, { nonInteractive: true });
    expect(out.changes).toContain("set secret UNSUBSCRIBE_SIGNING_KEY");
    expect(out.changes).not.toContain("set secret ENCRYPTION_KEY");
    expect(worker.secrets.get("ENCRYPTION_KEY")).toBe("operator-set-value");
    // A value generated earlier is reused rather than replaced by a new one.
    expect(worker.secrets.get("UNSUBSCRIBE_SIGNING_KEY")).toBe(loadState(env.configDir, "default")!.generatedSecrets.UNSUBSCRIBE_SIGNING_KEY);
  });
});

describe("claros deploy: workers.dev", () => {
  it("without --domain the host comes from the first deploy, then BASE_URL is set and deployed", async () => {
    const env = testEnv();
    await deploy(env.ctx, { nonInteractive: true });
    const host = "claros-default.acme.workers.dev";
    const config = deployedConfig(env);
    expect(config.workers_dev).toBe(true);
    expect(config.routes).toEqual([]);
    expect(config.vars.BASE_URL).toBe(`https://${host}`);
    expect(loadState(env.configDir, "default")).toMatchObject({ host, customDomain: false });
    expect(env.cf.mutating().filter((c) => c.startsWith("deploy"))).toHaveLength(2);
    expect(env.warnings.join("\n")).not.toMatch(/does not answer/);
  });
});

describe("claros deploy: custom domains and DNS", () => {
  it("stops before attaching a domain that has a DNS record, and says which", async () => {
    const env = testEnv();
    env.cf.dnsRecords.add(DOMAIN);
    await expect(deploy(env.ctx, { domain: DOMAIN, nonInteractive: true })).rejects.toThrow(
      `${DOMAIN}: a DNS record for this host already exists`,
    );
    // The Worker was created without routes for the check; no deploy carried the domain.
    const deploys = env.cf.calls.filter((c) => c[0] === "deploy");
    expect(deploys).toHaveLength(1);
    expect(deployedConfig(env).routes).toEqual([]);
  });

  it("stops when the domain belongs to another Worker", async () => {
    const env = testEnv();
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.otherWorkerDomains.set("news.example.com", "someone-else");
    env.cf.products.push({ slug: "news", publicHost: "news.example.com" });
    env.cf.anyUser = true;
    env.cf.resetCalls();
    await expect(deploy(env.ctx, { nonInteractive: true })).rejects.toThrow('news.example.com: already a custom domain of the Worker "someone-else"');
    expect(env.cf.mutating()).toEqual([]);
  });

  it("product public hosts from D1 become custom domain routes (archived products excluded)", async () => {
    const env = testEnv();
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.products.push({ slug: "b", publicHost: "b.example.com" }, { slug: "a", publicHost: "a.example.com" });
    env.cf.products.push({ slug: "old", publicHost: "old.example.com", archived: true });
    env.cf.anyUser = true;
    const out = await deploy(env.ctx, { nonInteractive: true });
    expect(out.changes).toEqual(["deploy the Worker (Claros 0.8.0)"]);
    expect(deployedConfig(env).routes.map((r: { pattern: string }) => r.pattern)).toEqual([DOMAIN, "a.example.com", "b.example.com"]);
  });
});

describe("claros deploy: account and login", () => {
  it("not logged in and non-interactive: tells how to log in", async () => {
    const env = testEnv();
    env.cf.loggedIn = false;
    await expect(deploy(env.ctx, { nonInteractive: true })).rejects.toThrow(/npx wrangler login/);
  });

  it("several accounts: --account is required when non-interactive; it picks the account", async () => {
    const env = testEnv();
    env.cf.accounts.push({ id: "acc-2", name: "Other" });
    await expect(deploy(env.ctx, { nonInteractive: true })).rejects.toThrow(/pass --account/);
    await deploy(env.ctx, { nonInteractive: true, account: "Other", domain: DOMAIN });
    expect(loadState(env.configDir, "default")!.accountId).toBe("acc-2");
    expect(env.cf.calls.filter((c) => c[0] === "deploy").length).toBeGreaterThan(0);
  });

  it("several accounts, interactive: asks which one", async () => {
    const env = testEnv({ prompt: async () => "2" });
    env.cf.accounts.push({ id: "acc-2", name: "Other" });
    await deploy(env.ctx, { domain: DOMAIN });
    expect(loadState(env.configDir, "default")!.accountId).toBe("acc-2");
  });

  it("warns about Workers Free limits unless a paid plan is confirmed", async () => {
    const free = testEnv();
    await deploy(free.ctx, { domain: DOMAIN, nonInteractive: true, dryRun: true });
    expect(free.warnings.join("\n")).toMatch(/Workers Paid/);
    const paid = testEnv();
    paid.cf.workersPaid = true;
    await deploy(paid.ctx, { domain: DOMAIN, nonInteractive: true, dryRun: true });
    expect(paid.warnings.join("\n")).not.toMatch(/Workers Paid/);
  });

  it("rejects invalid names and domains", async () => {
    const env = testEnv();
    await expect(deploy(env.ctx, { name: "Bad_Name", nonInteractive: true })).rejects.toThrow(/Invalid instance name/);
    await expect(deploy(env.ctx, { domain: "https://x.example.com:8443/path", nonInteractive: true })).rejects.toThrow(/Invalid --domain/);
  });
});

describe("claros upgrade", () => {
  it("backs up D1, applies new migrations, deploys and waits for the new version", async () => {
    const env = testEnv({ version: "0.8.0" });
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.anyUser = true;
    env.cf.migrations.push("0005_next.sql");
    env.cf.resetCalls();

    const next = testEnv({ cf: env.cf, configDir: env.configDir, version: "0.8.1" });
    const out = await upgrade(next.ctx, { nonInteractive: true });
    expect(out.upgraded).toBe(true);
    expect(out.backup).toMatch(/default\/backups\/.*-0\.8\.0\.sql$/);
    expect(readFileSync(out.backup!, "utf8")).toContain("fake export");
    expect(env.cf.applied.has("0005_next.sql")).toBe(true);
    expect(deployedConfig(env).vars.CLAROS_VERSION).toBe("0.8.1");
    expect(loadState(env.configDir, "default")!.deployedVersion).toBe("0.8.1");
    // Order: export, migrations, deploy.
    const order = env.cf.calls.map((c) => c.slice(0, 3).join(" "));
    expect(order.indexOf("d1 export DB")).toBeLessThan(order.indexOf("d1 migrations apply"));
    expect(order.indexOf("d1 migrations apply")).toBeLessThan(order.lastIndexOf("deploy --config " + join(env.configDir, "default", "wrangler.jsonc")));
  });

  it("records a D1 Time Travel bookmark before migrating and prints the restore command", async () => {
    const env = testEnv({ version: "0.8.0" });
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.migrations.push("0005_next.sql");
    env.cf.resetCalls();

    const next = testEnv({ cf: env.cf, configDir: env.configDir, version: "0.8.1" });
    const out = await upgrade(next.ctx, { nonInteractive: true });
    expect(out.bookmark).toBe(env.cf.bookmark);
    const info = env.cf.calls.find((c) => c.slice(0, 3).join(" ") === "d1 time-travel info")!;
    expect(info).toEqual(["d1", "time-travel", "info", "DB", "--json", "--config", join(env.configDir, "default", "wrangler.jsonc")]);
    const order = env.cf.calls.map((c) => c.slice(0, 3).join(" "));
    expect(order.indexOf("d1 time-travel info")).toBeLessThan(order.indexOf("d1 migrations apply"));

    expect(loadState(env.configDir, "default")!.lastUpgradeBackup).toEqual({
      takenAt: "2026-11-25T12:00:00.000Z",
      fromVersion: "0.8.0",
      toVersion: "0.8.1",
      bookmark: env.cf.bookmark,
      sqlFile: out.backup,
    });
    expect(next.logs.join("\n")).toContain(`npx wrangler d1 time-travel restore claros-default --bookmark ${env.cf.bookmark}`);
  });

  it("exports only the regular tables (no FTS5 index or internal tables)", async () => {
    const env = testEnv({ version: "0.8.0" });
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.resetCalls();
    const next = testEnv({ cf: env.cf, configDir: env.configDir, version: "0.8.1" });
    await upgrade(next.ctx, { nonInteractive: true });

    const exp = env.cf.calls.find((c) => c[0] === "d1" && c[1] === "export")!;
    const tables = exp.flatMap((a, i) => (exp[i - 1] === "--table" ? [a] : []));
    expect(tables).toEqual(["d1_migrations", "kb_entries", "tenants"]);
    expect(exp.filter((a) => a === "--table")).toHaveLength(3);
    expect(exp).toContain("--remote");
    expect(next.warnings).toEqual([]);
  });

  it("only warns when the SQL export fails and the bookmark was taken", async () => {
    const env = testEnv({ version: "0.8.0" });
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.migrations.push("0005_next.sql");
    env.cf.failExport = "✘ [ERROR] D1 Export error: something went wrong";
    const next = testEnv({ cf: env.cf, configDir: env.configDir, version: "0.8.1" });
    const out = await upgrade(next.ctx, { nonInteractive: true });

    expect(out).toMatchObject({ upgraded: true, backup: null, bookmark: env.cf.bookmark });
    expect(next.warnings.join("\n")).toMatch(/SQL export of D1 failed; going on with the Time Travel bookmark/);
    expect(env.cf.applied.has("0005_next.sql")).toBe(true);
    expect(loadState(env.configDir, "default")!.lastUpgradeBackup).toMatchObject({ bookmark: env.cf.bookmark, sqlFile: null });
  });

  it("goes on with the SQL export when no bookmark can be read", async () => {
    const env = testEnv({ version: "0.8.0" });
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.failBookmark = "✘ [ERROR] Time travel is not available for alpha D1 databases.";
    const next = testEnv({ cf: env.cf, configDir: env.configDir, version: "0.8.1" });
    const out = await upgrade(next.ctx, { nonInteractive: true });
    expect(out).toMatchObject({ upgraded: true, bookmark: null });
    expect(readFileSync(out.backup!, "utf8")).toContain("fake export");
    expect(next.warnings.join("\n")).toMatch(/Could not read a D1 Time Travel bookmark/);
  });

  it("stops before migrating when neither the bookmark nor the export works", async () => {
    const env = testEnv({ version: "0.8.0" });
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.migrations.push("0005_next.sql");
    env.cf.failBookmark = "✘ [ERROR] A request to the Cloudflare API failed.";
    env.cf.failExport = "✘ [ERROR] D1 Export error: something went wrong";
    env.cf.resetCalls();
    const next = testEnv({ cf: env.cf, configDir: env.configDir, version: "0.8.1" });

    await expect(upgrade(next.ctx, { nonInteractive: true })).rejects.toThrow(/Stopped before migrating: could not back up D1/);
    expect(env.cf.applied.has("0005_next.sql")).toBe(false);
    expect(env.cf.mutating()).toEqual([]);
    expect(env.cf.calls.some((c) => c[0] === "d1" && c[1] === "migrations")).toBe(false);
    expect(loadState(env.configDir, "default")).toMatchObject({ deployedVersion: "0.8.0", lastUpgradeBackup: null });
  });

  it("refuses to downgrade", async () => {
    const env = testEnv({ version: "0.8.1" });
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    const older = testEnv({ cf: env.cf, configDir: env.configDir, version: "0.8.0" });
    env.cf.resetCalls();
    await expect(upgrade(older.ctx, { nonInteractive: true })).rejects.toThrow(/Refusing to downgrade "default" from 0.8.1 to 0.8.0/);
    await expect(upgrade(older.ctx, { nonInteractive: true })).rejects.toThrow("Use `npx @claroshq/claros@0.8.1 upgrade` or newer.");
    expect(env.cf.mutating()).toEqual([]);
    expect(env.cf.exports).toEqual([]);
  });

  it("rolls the Worker back when the new version does not come up", async () => {
    const env = testEnv({ version: "0.8.0" });
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    const before = loadState(env.configDir, "default")!.versionId;
    const next = testEnv({ cf: env.cf, configDir: env.configDir, version: "0.8.1" });
    env.cf.healthy = false;
    await expect(upgrade(next.ctx, { nonInteractive: true })).rejects.toThrow(/failed and was rolled back/);
    const rollback = env.cf.calls.find((c) => c[0] === "rollback")!;
    expect(rollback[1]).toBe(before);
    expect(env.cf.workers.get("claros-default")!.active).toBe(before);
    expect(loadState(env.configDir, "default")).toMatchObject({ deployedVersion: "0.8.0", versionId: before });
    expect(next.warnings.join("\n")).toMatch(/D1 migrations are not rolled back/);
    expect(next.warnings.join("\n")).toContain(`Time Travel: npx wrangler d1 time-travel restore claros-default --bookmark ${env.cf.bookmark}`);
  });

  it("rolls back when the deploy itself fails", async () => {
    const env = testEnv({ version: "0.8.0" });
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    const next = testEnv({ cf: env.cf, configDir: env.configDir, version: "0.9.0" });
    env.cf.failDeploy = "✘ [ERROR] A request to the Cloudflare API failed.";
    await expect(upgrade(next.ctx, { nonInteractive: true })).rejects.toThrow(/rolled back/);
    expect(env.cf.calls.some((c) => c[0] === "rollback")).toBe(true);
  });

  it("needs a deployed instance", async () => {
    const env = testEnv();
    await expect(upgrade(env.ctx, { nonInteractive: true })).rejects.toThrow(/No local state for instance "default"/);
  });
});

describe("claros products set-host", () => {
  it("sets tenants.public_host and redeploys with a custom domain route", async () => {
    const env = testEnv();
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.products.push({ slug: "news", publicHost: null });
    await setProductHost(env.ctx, { slug: "news", host: "News.Example.com", nonInteractive: true });
    expect(env.cf.products[0]!.publicHost).toBe("news.example.com");
    expect(deployedConfig(env).routes.map((r: { pattern: string }) => r.pattern)).toEqual([DOMAIN, "news.example.com"]);

    env.cf.resetCalls();
    await setProductHost(env.ctx, { slug: "news", host: "news.example.com", nonInteractive: true });
    expect(env.cf.mutating()).toEqual([]);
  });

  it("refuses unknown products, taken hosts and the instance host", async () => {
    const env = testEnv();
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    env.cf.products.push({ slug: "aa", publicHost: "a.example.com" }, { slug: "bb", publicHost: null });
    await expect(setProductHost(env.ctx, { slug: "zz", host: "z.example.com", nonInteractive: true })).rejects.toThrow(/No product with slug "zz"/);
    await expect(setProductHost(env.ctx, { slug: "bb", host: "a.example.com", nonInteractive: true })).rejects.toThrow(/already the public host of product "aa"/);
    await expect(setProductHost(env.ctx, { slug: "bb", host: DOMAIN, nonInteractive: true })).rejects.toThrow(/instance host/);
    await expect(setProductHost(env.ctx, { slug: "b'; DROP TABLE x;--", host: "c.example.com", nonInteractive: true })).rejects.toThrow(/Invalid product slug/);
  });
});

describe("claros doctor", () => {
  it("reports secrets, migrations, HTTPS routes, /health and /version", async () => {
    const env = testEnv();
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    const checks = await doctor(env.ctx, { nonInteractive: true });
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ["secrets", true],
      ["migrations", true],
      [`https://${DOMAIN}/health`, true],
      ["version", true],
    ]);

    env.cf.workers.get("claros-default")!.secrets.delete("ENCRYPTION_KEY");
    env.cf.migrations.push("0009_new.sql");
    const bad = await doctor(env.ctx, { nonInteractive: true });
    expect(bad.find((c) => c.name === "secrets")).toMatchObject({ ok: false, detail: "missing ENCRYPTION_KEY" });
    expect(bad.find((c) => c.name === "migrations")).toMatchObject({ ok: false, detail: "pending: 0009_new.sql" });
  });
});

describe("claros claim-url", () => {
  it("mints a new link while no user exists, and none after", async () => {
    const env = testEnv();
    await deploy(env.ctx, { domain: DOMAIN, nonInteractive: true });
    const url = await claimUrlCommand(env.ctx, { nonInteractive: true });
    expect(url).toMatch(/^https:\/\/claros\.example\.com\/claim\?token=/);
    expect(env.cf.claimSql).toHaveLength(2);

    expect(env.logs.join("\n")).toContain("npx @claroshq/claros claim-url");

    env.cf.anyUser = true;
    expect(await claimUrlCommand(env.ctx, { nonInteractive: true })).toBeNull();
    expect(env.cf.claimSql).toHaveLength(2);
  });
});
