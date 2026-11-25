import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Assets } from "../../src/assets.js";
import type { Context, Io } from "../../src/ops.js";
import { Wrangler } from "../../src/wrangler.js";
import { FakeCloudflare } from "./fake-cloudflare.js";

export interface TestEnv {
  cf: FakeCloudflare;
  ctx: Context;
  configDir: string;
  logs: string[];
  warnings: string[];
  assets: Assets;
}

export function fakeAssets(version = "0.8.0"): Assets {
  const dir = mkdtempSync(join(tmpdir(), "claros-cli-assets-"));
  mkdirSync(join(dir, "worker"));
  mkdirSync(join(dir, "dashboard"));
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "worker", "index.js"), "export default {}");
  return {
    workerMain: join(dir, "worker", "index.js"),
    dashboardDir: join(dir, "dashboard"),
    migrationsDir: join(dir, "migrations"),
    version,
  };
}

export function testEnv(opts: { cf?: FakeCloudflare; configDir?: string; version?: string; prompt?: Io["prompt"] } = {}): TestEnv {
  const cf = opts.cf ?? new FakeCloudflare();
  const configDir = opts.configDir ?? mkdtempSync(join(tmpdir(), "claros-cli-state-"));
  const logs: string[] = [];
  const warnings: string[] = [];
  const assets = fakeAssets(opts.version);
  let clock = Date.UTC(2026, 10, 25, 12, 0, 0);
  let n = 0;
  const ctx: Context = {
    wrangler: new Wrangler(cf.runner),
    fetch: cf.fetch,
    io: { log: (l = "") => logs.push(l), warn: (l) => warnings.push(l), prompt: opts.prompt },
    configDir,
    assets: () => assets,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    // Deterministic but distinct bytes per call.
    random: (size) => Buffer.alloc(size, ++n),
    pollTimeoutMs: 30_000,
    pollIntervalMs: 1000,
  };
  return { cf, ctx, configDir, logs, warnings, assets };
}

/** The account the fake Worker answered as after a deploy. */
export function deployedConfig(env: TestEnv, worker = "claros-default"): any {
  return env.cf.workers.get(worker)?.config;
}
