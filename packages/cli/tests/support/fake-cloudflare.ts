/**
 * A fake Cloudflare account behind a fake wrangler Runner and a fake fetch.
 *
 * It answers the wrangler commands the CLI runs with output in wrangler's
 * formats, keeps the account's resources in memory, and records every call
 * so tests can assert which commands changed something.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Runner, RunResult } from "../../src/wrangler.js";
import { ANY_USER_SQL } from "../../src/claim.js";
import { PRODUCT_HOSTS_SQL } from "../../src/ops.js";

export interface FakeWorker {
  secrets: Map<string, string>;
  config: any;
  versions: string[];
  /** Version id currently serving (rollback moves it). */
  active: string;
}

export interface Product {
  slug: string;
  publicHost: string | null;
  archived?: boolean;
}

const MUTATING = [
  /^d1 create/,
  /^queues create/,
  /^deploy/,
  /^d1 migrations apply/,
  /^rollback/,
  /^secret put/,
  /^d1 execute .*--command (DELETE|INSERT|UPDATE)/,
];

export class FakeCloudflare {
  loggedIn = true;
  accounts = [{ id: "acc-1", name: "Acme" }];
  d1 = new Map<string, string>(); // name -> uuid
  queues = new Set<string>();
  workers = new Map<string, FakeWorker>();
  migrations = ["0000_baseline.sql", "0001_kb_fts.sql", "0004_claim_tokens.sql"];
  applied = new Set<string>();
  products: Product[] = [];
  anyUser = false;
  claimSql: string[] = [];
  /** Hosts with an existing DNS record (conflicting custom domains). */
  dnsRecords = new Set<string>();
  /** host -> other Worker that has it as custom domain. */
  otherWorkerDomains = new Map<string, string>();
  workersPaid = false;
  /** When false, /version answers 503 (deploy never becomes healthy). */
  healthy = true;
  /** Fail the next deploy with this message. */
  failDeploy: string | null = null;
  calls: string[][] = [];
  exports: string[] = [];
  private workersDevSubdomain = "acme";

  /** Calls that changed something on the account. */
  mutating(): string[] {
    return this.calls.map((c) => c.join(" ")).filter((c) => MUTATING.some((m) => m.test(c)));
  }

  resetCalls(): void {
    this.calls = [];
  }

  private configOf(args: string[]): any {
    const i = args.indexOf("--config");
    if (i < 0) throw new Error(`fake: no --config in ${args.join(" ")}`);
    const text = readFileSync(args[i + 1]!, "utf8");
    return JSON.parse(text.split("\n").filter((l) => !l.startsWith("//")).join("\n"));
  }

  private ok(stdout = ""): RunResult {
    return { code: 0, stdout, stderr: "" };
  }

  private fail(stderr: string): RunResult {
    return { code: 1, stdout: "", stderr };
  }

  private sqlResult(results: Array<Record<string, unknown>>[]): RunResult {
    return this.ok(JSON.stringify(results.map((r) => ({ results: r, success: true, meta: {} }))));
  }

  readonly runner: Runner = async (args, opts) => {
    this.calls.push(args);
    if (opts?.env?.CLOUDFLARE_ACCOUNT_ID && !this.accounts.some((a) => a.id === opts.env!.CLOUDFLARE_ACCOUNT_ID)) {
      return this.fail("account not found");
    }
    const cmd = args.slice(0, 2).join(" ");
    switch (true) {
      case cmd === "whoami --json":
        return this.loggedIn
          ? this.ok(JSON.stringify({ loggedIn: true, email: "op@example.com", accounts: this.accounts }))
          : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
      case cmd === "auth token":
        return this.ok(JSON.stringify({ type: "oauth", token: "fake-token" }));
      case cmd === "d1 list":
        return this.ok(`⛅️ wrangler 4\n${JSON.stringify([...this.d1].map(([name, uuid]) => ({ uuid, name })))}`);
      case cmd === "d1 create":
        this.d1.set(args[2]!, randomUUID());
        return this.ok("Successfully created DB");
      case cmd === "queues info":
        return this.queues.has(args[2]!) ? this.ok(`Queue Name: ${args[2]}`) : this.fail(`Queue "${args[2]}" does not exist.`);
      case cmd === "queues create":
        this.queues.add(args[2]!);
        return this.ok("Created queue");
      case cmd === "secret list": {
        const w = this.workers.get(this.configOf(args).name);
        if (!w) return this.fail(`Worker "${this.configOf(args).name}" not found.`);
        return this.ok(JSON.stringify([...w.secrets.keys()].map((name) => ({ name, type: "secret_text" }))));
      }
      case cmd === "d1 execute":
        return this.execute(args);
      case cmd === "d1 migrations":
        if (args[2] === "list") {
          const pending = this.migrations.filter((m) => !this.applied.has(m));
          if (pending.length === 0) return this.ok("✅ No migrations to apply!");
          return this.ok(`Migrations to be applied:\n┌──┐\n${pending.map((p) => `│ ${p} │`).join("\n")}\n└──┘`);
        }
        for (const m of this.migrations) this.applied.add(m);
        return this.ok("applied");
      case cmd === "d1 export": {
        const out = args[args.indexOf("--output") + 1]!;
        writeFileSync(out, "-- fake export\n");
        this.exports.push(out);
        return this.ok("exported");
      }
      case args[0] === "deploy":
        return this.deploy(args);
      case args[0] === "rollback": {
        const config = this.configOf(args);
        const w = this.workers.get(config.name)!;
        const target = args[1] && !args[1].startsWith("--") ? args[1] : w.versions[w.versions.length - 2]!;
        w.active = target;
        return this.ok("rolled back");
      }
      default:
        return this.fail(`fake: unexpected wrangler ${args.join(" ")}`);
    }
  };

  private execute(args: string[]): RunResult {
    const sql = args[args.indexOf("--command") + 1]!;
    if (sql === PRODUCT_HOSTS_SQL) {
      if (!this.applied.size) return this.fail("✘ ERROR: no such table: tenants: SQLITE_ERROR");
      return this.sqlResult([
        this.products.filter((p) => p.publicHost && !p.archived).map((p) => ({ public_host: p.publicHost })),
      ]);
    }
    if (sql === ANY_USER_SQL) return this.sqlResult([[{ any_user: this.anyUser ? 1 : 0 }]]);
    if (sql.startsWith("DELETE FROM claim_tokens")) {
      this.claimSql.push(sql);
      return this.sqlResult([[], []]);
    }
    let m = /^SELECT id, public_host FROM tenants WHERE slug = '([^']+)'$/.exec(sql);
    if (m) {
      const p = this.products.find((x) => x.slug === m![1]);
      return this.sqlResult([p ? [{ id: `id-${p.slug}`, public_host: p.publicHost }] : []]);
    }
    m = /^SELECT slug FROM tenants WHERE public_host = '([^']+)' AND slug <> '([^']+)'$/.exec(sql);
    if (m) return this.sqlResult([this.products.filter((p) => p.publicHost === m![1] && p.slug !== m![2]).map((p) => ({ slug: p.slug }))]);
    m = /^UPDATE tenants SET public_host = '([^']+)' WHERE slug = '([^']+)'$/.exec(sql);
    if (m) {
      this.products.find((p) => p.slug === m![2])!.publicHost = m[1]!;
      return this.sqlResult([[]]);
    }
    return this.fail(`fake: unexpected SQL ${sql}`);
  }

  private deploy(args: string[]): RunResult {
    if (this.failDeploy) {
      const msg = this.failDeploy;
      this.failDeploy = null;
      return this.fail(msg);
    }
    const config = this.configOf(args);
    let w = this.workers.get(config.name);
    if (!w) {
      w = { secrets: new Map(), config, versions: [], active: "" };
      this.workers.set(config.name, w);
    }
    const sf = args.indexOf("--secrets-file");
    if (sf >= 0) {
      const secrets = JSON.parse(readFileSync(args[sf + 1]!, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(secrets)) w.secrets.set(k, v);
    }
    w.config = config;
    const id = randomUUID();
    w.versions.push(id);
    w.active = id;
    const lines = [`Uploaded ${config.name}`];
    if (config.workers_dev) lines.push(`  https://${config.name}.${this.workersDevSubdomain}.workers.dev`);
    for (const r of config.routes ?? []) lines.push(`  ${r.pattern} (custom domain)`);
    lines.push(`Current Version ID: ${id}`);
    return this.ok(lines.join("\n"));
  }

  /** Which Worker serves a host. */
  private workerForHost(host: string): FakeWorker | undefined {
    for (const [name, w] of this.workers) {
      if (w.config.workers_dev && host === `${name}.${this.workersDevSubdomain}.workers.dev`) return w;
      if ((w.config.routes ?? []).some((r: { pattern: string }) => r.pattern === host)) return w;
    }
    return undefined;
  }

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.hostname === "api.cloudflare.com") {
      const path = url.pathname;
      let m = /\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/domains\/changeset$/.exec(path);
      if (m) {
        if (!this.workers.has(m[2]!)) {
          return Response.json({ success: false, errors: [{ code: 10007, message: "workers.api.error.script_not_found" }] }, { status: 404 });
        }
        const hosts = (JSON.parse(String(init?.body)) as Array<{ hostname: string }>).map((h) => h.hostname);
        return Response.json({
          success: true,
          result: {
            added: [],
            removed: [],
            conflicting: hosts.filter((h) => this.dnsRecords.has(h)).map((hostname) => ({ hostname })),
            updated: hosts
              .filter((h) => this.otherWorkerDomains.has(h))
              .map((hostname) => ({ id: `dom-${hostname}`, hostname, modified: true })),
          },
        });
      }
      m = /\/workers\/domains\/records\/dom-(.+)$/.exec(path);
      if (m) return Response.json({ success: true, result: { service: this.otherWorkerDomains.get(m[1]!) } });
      if (/\/subscriptions$/.test(path)) {
        return Response.json({
          success: true,
          result: this.workersPaid ? [{ rate_plan: { id: "workers_paid", public_name: "Workers Paid" } }] : [],
        });
      }
      return Response.json({ success: false, errors: [{ code: 7000, message: "No route" }] }, { status: 404 });
    }
    const w = this.workerForHost(url.hostname);
    if (!w) throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${url.hostname}`);
    if (url.pathname === "/health") return Response.json({ status: "ok", role: "all", edition: "community" });
    if (url.pathname === "/version") {
      if (!this.healthy) return new Response("unavailable", { status: 503 });
      // The active version's CLAROS_VERSION (rollback restores the earlier one).
      const version = w.active === w.versions[w.versions.length - 1] ? w.config.vars?.CLAROS_VERSION : "previous";
      return Response.json({ commit: "unknown", edition: "community", builtAt: null, version });
    }
    return new Response("not found", { status: 404 });
  };
}
