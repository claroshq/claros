/**
 * Unit tests: the generated wrangler.jsonc, state handling, version order,
 * claim token hashing and wrangler output parsing.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPATIBILITY_DATE, CRON, RUN_WORKER_FIRST, SEND_EMAIL_BINDING, configHash, generateConfig, renderConfig } from "../src/template.js";
import { loadState, newState, saveState, statePath } from "../src/state.js";
import { compareVersions } from "../src/version.js";
import { hashClaimToken, mintClaimToken } from "../src/claim.js";
import { Wrangler, parseJsonOutput, type Runner } from "../src/wrangler.js";
import { normalizeHost } from "../src/ops.js";
import { packageVersion } from "../src/assets.js";
import { fakeAssets } from "./support/context.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");

function devTemplate(): any {
  const text = readFileSync(join(repo, "apps", "worker", "wrangler.jsonc"), "utf8");
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

function stateWith(over: Partial<ReturnType<typeof newState>> = {}) {
  return { ...newState("prod", "acc-1"), d1Id: "db-uuid", ...over };
}

describe("generated wrangler.jsonc", () => {
  const assets = fakeAssets("0.8.0");

  it("matches the development template (apps/worker/wrangler.jsonc) in bindings, queues, cron and assets rules", () => {
    const dev = devTemplate();
    const cfg = generateConfig({ state: stateWith({ host: "c.example.com", customDomain: true }), assets, productHosts: [] });
    expect(cfg.compatibility_date).toBe(dev.compatibility_date);
    expect(COMPATIBILITY_DATE).toBe(dev.compatibility_date);
    expect(cfg.compatibility_flags).toEqual(dev.compatibility_flags);
    expect(cfg.triggers).toEqual(dev.triggers);
    expect([CRON]).toEqual(dev.triggers.crons);
    expect(cfg.d1_databases.map((d) => d.binding)).toEqual(dev.d1_databases.map((d: any) => d.binding));
    expect(cfg.queues.producers.map((p) => p.binding)).toEqual(dev.queues.producers.map((p: any) => p.binding));
    const rename = (q: string) => q.replace("claros-prod", "claros");
    expect(cfg.queues.consumers.map((c) => ({ ...c, queue: rename(String(c.queue)), ...(c.dead_letter_queue ? { dead_letter_queue: rename(String(c.dead_letter_queue)) } : {}) }))).toEqual(dev.queues.consumers);
    const { directory: _a, ...devAssets } = dev.assets;
    const { directory: _b, ...genAssets } = cfg.assets as any;
    expect(genAssets).toEqual(devAssets);
    expect(RUN_WORKER_FIRST).toEqual(dev.assets.run_worker_first);
    expect(cfg.observability).toEqual(dev.observability);
  });

  it("fills in names, ids, paths, BASE_URL, the version and custom domain routes", () => {
    const cfg = generateConfig({
      state: stateWith({ host: "claros.example.com", customDomain: true }),
      assets,
      productHosts: ["z.example.com", "a.example.com", "claros.example.com"],
    });
    expect(cfg).toMatchObject({
      name: "claros-prod",
      main: assets.workerMain,
      account_id: "acc-1",
      workers_dev: false,
      routes: [
        { pattern: "claros.example.com", custom_domain: true },
        { pattern: "a.example.com", custom_domain: true },
        { pattern: "z.example.com", custom_domain: true },
      ],
      d1_databases: [{ binding: "DB", database_name: "claros-prod", database_id: "db-uuid", migrations_dir: assets.migrationsDir }],
      queues: { producers: [{ binding: "JOBS", queue: "claros-prod-jobs" }] },
      vars: { BASE_URL: "https://claros.example.com", CLAROS_VERSION: "0.8.0" },
    });
    expect(cfg.queues.consumers[0]).toMatchObject({ queue: "claros-prod-jobs", dead_letter_queue: "claros-prod-jobs-dlq" });
    expect((cfg.assets as any).directory).toBe(assets.dashboardDir);
  });

  it("workers.dev install: workers_dev on, product hosts only, no BASE_URL until the host is known", () => {
    const cfg = generateConfig({ state: stateWith(), assets, productHosts: ["news.example.com"] });
    expect(cfg.workers_dev).toBe(true);
    expect(cfg.routes).toEqual([{ pattern: "news.example.com", custom_domain: true }]);
    expect(cfg.vars).toEqual({ CLAROS_VERSION: "0.8.0" });
    expect(generateConfig({ state: stateWith(), assets, productHosts: ["news.example.com"], withoutRoutes: true }).routes).toEqual([]);
  });

  it("always binds Cloudflare Email Service as EMAIL, without sender or recipient restrictions", () => {
    for (const state of [stateWith(), stateWith({ host: "c.example.com", customDomain: true })]) {
      const cfg = generateConfig({ state, assets, productHosts: [], withoutRoutes: true });
      expect(cfg.send_email).toEqual([{ name: "EMAIL" }]);
    }
    expect(SEND_EMAIL_BINDING).toBe("EMAIL");
    // The Worker reads the binding as env.EMAIL; the development template keeps it commented out.
    const source = readFileSync(join(repo, "apps", "worker", "src", "transports.ts"), "utf8");
    expect(source).toContain(`env.${SEND_EMAIL_BINDING} `);
    expect(devTemplate().send_email).toBeUndefined();
  });

  it("renders as JSON with comments that wrangler reads; the hash ignores local paths", () => {
    const state = stateWith({ host: "c.example.com", customDomain: true });
    const cfg = generateConfig({ state, assets, productHosts: [] });
    const text = renderConfig(cfg);
    expect(text.startsWith("// Generated by `claros deploy`")).toBe(true);
    expect(JSON.parse(text.replace(/^\/\/.*$/gm, ""))).toEqual(cfg);
    const elsewhere = generateConfig({ state, assets: fakeAssets("0.8.0"), productHosts: [] });
    expect(configHash(elsewhere)).toBe(configHash(cfg));
    expect(configHash(generateConfig({ state, assets: fakeAssets("0.8.1"), productHosts: [] }))).not.toBe(configHash(cfg));
    expect(configHash(generateConfig({ state, assets, productHosts: ["n.example.com"] }))).not.toBe(configHash(cfg));
  });
});

describe("state cache", () => {
  it("saves with mode 600 and loads back", () => {
    const dir = mkdtempSync(join(tmpdir(), "claros-state-"));
    expect(loadState(dir, "prod")).toBeNull();
    const state = stateWith({ host: "c.example.com", generatedSecrets: { ENCRYPTION_KEY: "k" } });
    const path = saveState(dir, state);
    expect(path).toBe(statePath(dir, "prod"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadState(dir, "prod")).toEqual(state);
    // Re-saving keeps 600 even if someone loosened it.
    writeFileSync(path, readFileSync(path), { mode: 0o644 });
    saveState(dir, state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a file that is not this instance's state", () => {
    const dir = mkdtempSync(join(tmpdir(), "claros-state-"));
    writeFileSync(statePath(dir, "prod"), "{not json");
    expect(() => loadState(dir, "prod")).toThrow(/not valid JSON/);
    writeFileSync(statePath(dir, "prod"), JSON.stringify({ name: "other", accountId: "a" }));
    expect(() => loadState(dir, "prod")).toThrow(/does not look like/);
  });

  it("fills fields missing from an older state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "claros-state-"));
    writeFileSync(statePath(dir, "prod"), JSON.stringify({ name: "prod", accountId: "acc-1", host: "c.example.com" }));
    expect(loadState(dir, "prod")).toMatchObject({ workerName: "claros-prod", queues: { jobs: "claros-prod-jobs" }, generatedSecrets: {}, host: "c.example.com" });
  });
});

describe("versions", () => {
  it("orders releases and release candidates", () => {
    expect(compareVersions("0.8.0", "0.7.9")).toBeGreaterThan(0);
    expect(compareVersions("0.8.0", "0.8.0")).toBe(0);
    expect(compareVersions("0.8.0-rc.2", "0.8.0")).toBeLessThan(0);
    expect(compareVersions("0.8.0-rc.10", "0.8.0-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(() => compareVersions("latest", "0.8.0")).toThrow();
  });

  it("the package version is the release version", () => {
    expect(packageVersion()).toBe(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version);
  });
});

describe("claim token", () => {
  it("hashes like the API (SHA-256 hex)", () => {
    // Same vector as packages/api/tests/claim.test.ts.
    expect(hashClaimToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("SQL holds only the hash and a 24 hour expiry", () => {
    const now = new Date(Date.UTC(2026, 0, 1));
    const { token, sql } = mintClaimToken(now, "raw-token");
    expect(token).toBe("raw-token");
    expect(sql).not.toContain("raw-token");
    expect(sql).toContain(`'${hashClaimToken("raw-token")}', ${now.getTime() + 86_400_000}, ${now.getTime()})`);
    expect(mintClaimToken().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("wrangler output parsing", () => {
  const runner = (stdout: string, code = 0, stderr = ""): Runner => async () => ({ code, stdout, stderr });
  const wr = (r: Runner) => new Wrangler(r, { configPath: "/tmp/w.jsonc", accountId: "acc" });

  it("JSON after a banner", () => {
    expect(parseJsonOutput("\n ⛅️ wrangler 4.1\n───\n[{\"uuid\":\"u\",\"name\":\"n\"}]")).toEqual([{ uuid: "u", name: "n" }]);
  });

  it("pending migrations from the table, none from the success line", async () => {
    const table = "Migrations to be applied:\n┌────────────────────┐\n│ name │\n├──┤\n│ 0003_suppressions_lower_email.sql │\n│ 0004_claim_tokens.sql │\n└──┘";
    expect(await wr(runner(table)).migrationsPending()).toEqual(["0003_suppressions_lower_email.sql", "0004_claim_tokens.sql"]);
    expect(await wr(runner("✅ No migrations to apply!")).migrationsPending()).toEqual([]);
  });

  it("deploy: version id and URLs", async () => {
    const out = "Uploaded claros-prod (3.1 sec)\nDeployed claros-prod triggers (1.2 sec)\n  https://claros-prod.acme.workers.dev\n  claros.example.com (custom domain)\nCurrent Version ID: 0f1e2d3c-1111-2222-3333-444455556666";
    const res = await wr(runner(out)).deploy();
    expect(res.versionId).toBe("0f1e2d3c-1111-2222-3333-444455556666");
    expect(res.urls).toEqual(["https://claros-prod.acme.workers.dev"]);
  });

  it("queue and Worker lookups tell missing from failed", async () => {
    expect(await wr(runner("", 1, 'Queue "q" does not exist. To create it, run: wrangler queues create q')).queueExists("q")).toBe(false);
    await expect(wr(runner("", 1, "Authentication error [code: 10000]")).queueExists("q")).rejects.toThrow(/Authentication error/);
    expect(await wr(runner("", 1, 'Worker "claros-prod" not found.')).secretNames()).toBeNull();
  });

  it("passes the account and never prints SQL in errors", async () => {
    let seen: Record<string, string> | undefined;
    const r: Runner = async (_args, opts) => {
      seen = opts?.env;
      return { code: 1, stdout: "", stderr: "boom" };
    };
    const err = await wr(r).d1Execute("DELETE FROM claim_tokens WHERE token_hash = 'secret'").catch((e: Error) => e);
    expect(seen?.CLOUDFLARE_ACCOUNT_ID).toBe("acc");
    expect(String(err)).toContain("<sql>");
    expect(String(err)).not.toContain("secret'");
  });
});

describe("host names", () => {
  it("normalizes and validates", () => {
    expect(normalizeHost("https://Claros.Example.com/")).toBe("claros.example.com");
    expect(() => normalizeHost("localhost")).toThrow();
    expect(() => normalizeHost("a.example.com:8443")).toThrow();
    expect(() => normalizeHost("x'.example.com")).toThrow();
  });
});

describe("command line", () => {
  it("help, version, usage errors", async () => {
    const { main, USAGE } = await import("../src/cli.js");
    expect(USAGE).toContain("npx @claroshq/claros <command>");
    expect(await main(["--help"])).toBe(0);
    expect(await main([])).toBe(2);
    expect(await main(["bogus"])).toBe(2);
    expect(await main(["products", "set-host", "only-slug"])).toBe(2);
    expect(await main(["deploy", "--unknown-flag"])).toBe(2);
  });

  it("deploy runs through main with injected dependencies", async () => {
    const { main } = await import("../src/cli.js");
    const { testEnv } = await import("./support/context.js");
    const env = testEnv();
    const code = await main(["deploy", "--domain", "claros.example.com", "--non-interactive"], {
      runner: env.cf.runner,
      fetch: env.cf.fetch,
      io: env.ctx.io,
      configDir: env.configDir,
      assets: env.ctx.assets,
    });
    expect(code).toBe(0);
    expect(env.cf.workers.has("claros-default")).toBe(true);
  });
});
