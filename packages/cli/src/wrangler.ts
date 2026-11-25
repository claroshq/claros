/**
 * Every wrangler call the CLI makes, in one place.
 *
 * `Runner` spawns wrangler with arguments and returns its exit code and
 * output; tests replace it with a fake that simulates a Cloudflare account.
 * `Wrangler` turns the calls into typed results, parsing JSON where wrangler
 * offers `--json` and the plain text output where it does not.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Written to the child's stdin. */
  input?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Inherit the terminal (login); output is not captured. */
  interactive?: boolean;
  /** Working directory. */
  cwd?: string;
}

export type Runner = (args: string[], opts?: RunOptions) => Promise<RunResult>;

/** The wrangler bin of the wrangler package this CLI depends on. */
export function wranglerBin(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
}

/** Runs the real wrangler (node <wrangler bin> ...args). */
export function spawnRunner(bin = wranglerBin()): Runner {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: opts.interactive ? "inherit" : ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (!opts.interactive) {
        if (opts.input !== undefined) child.stdin?.write(opts.input);
        child.stdin?.end();
      }
    });
}

/** A wrangler command failed. */
export class WranglerError extends Error {
  constructor(
    readonly args: string[],
    readonly result: RunResult,
  ) {
    super(`wrangler ${redactArgs(args).join(" ")} failed (exit ${result.code}):\n${tail(result.stderr || result.stdout)}`);
  }

  /** stdout and stderr together, for matching known error messages. */
  get output(): string {
    return `${this.result.stdout}\n${this.result.stderr}`;
  }
}

function tail(text: string, lines = 20): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/** SQL passed with --command is shown as "<sql>" in errors (it can hold token hashes). */
function redactArgs(args: string[]): string[] {
  return args.map((a, i) => (args[i - 1] === "--command" ? "<sql>" : a));
}

/** The first JSON value in wrangler's stdout (banners and warnings can precede it). */
export function parseJsonOutput<T>(stdout: string): T {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error(`expected JSON from wrangler, got: ${tail(stdout, 5)}`);
  return JSON.parse(stdout.slice(start)) as T;
}

export interface WhoAmI {
  loggedIn: boolean;
  email?: string;
  accounts: Array<{ id: string; name: string }>;
}

export interface D1Info {
  uuid: string;
  name: string;
}

export type AuthCredentials =
  | { type: "oauth" | "api_token"; token: string }
  | { type: "api_key"; key: string; email: string };

export interface DeployResult {
  /** Version id wrangler printed ("Current Version ID: ..."). */
  versionId: string | null;
  /** https URLs wrangler printed (workers.dev and custom domains). */
  urls: string[];
  output: string;
}

/** Name of the D1 binding in the generated configuration. */
export const D1_BINDING = "DB";

export class Wrangler {
  constructor(
    private readonly run: Runner,
    private readonly ctx: { accountId?: string; configPath?: string; cwd?: string } = {},
  ) {}

  /** The same runner bound to an account and a generated configuration file. */
  with(ctx: { accountId?: string; configPath?: string; cwd?: string }): Wrangler {
    return new Wrangler(this.run, { ...this.ctx, ...ctx });
  }

  private async exec(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const env: Record<string, string> = { ...(opts.env ?? {}) };
    if (this.ctx.accountId) env.CLOUDFLARE_ACCOUNT_ID = this.ctx.accountId;
    return this.run(args, { ...opts, env, cwd: opts.cwd ?? this.ctx.cwd });
  }

  private async ok(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const res = await this.exec(args, opts);
    if (res.code !== 0) throw new WranglerError(args, res);
    return res;
  }

  private config(): string[] {
    if (!this.ctx.configPath) throw new Error("internal: no wrangler configuration for this command");
    return ["--config", this.ctx.configPath];
  }

  async whoami(): Promise<WhoAmI> {
    const res = await this.exec(["whoami", "--json"]);
    if (res.code !== 0) return { loggedIn: false, accounts: [] };
    const out = parseJsonOutput<{ loggedIn?: boolean; email?: string; accounts?: Array<{ id: string; name: string }> }>(res.stdout);
    return { loggedIn: out.loggedIn !== false, email: out.email, accounts: out.accounts ?? [] };
  }

  async login(): Promise<void> {
    await this.ok(["login"], { interactive: true });
  }

  /** The credentials wrangler uses (for the few Cloudflare API reads wrangler has no command for). */
  async authToken(): Promise<AuthCredentials | null> {
    const res = await this.exec(["auth", "token", "--json"]);
    if (res.code !== 0) return null;
    return parseJsonOutput<AuthCredentials>(res.stdout);
  }

  async d1List(): Promise<D1Info[]> {
    const res = await this.ok(["d1", "list", "--json"]);
    return parseJsonOutput<D1Info[]>(res.stdout);
  }

  async d1Create(name: string): Promise<void> {
    await this.ok(["d1", "create", name]);
  }

  async queueExists(name: string): Promise<boolean> {
    const args = ["queues", "info", name];
    const res = await this.exec(args);
    if (res.code === 0) return true;
    if (/does not exist/i.test(`${res.stdout}\n${res.stderr}`)) return false;
    throw new WranglerError(args, res);
  }

  async queueCreate(name: string): Promise<void> {
    await this.ok(["queues", "create", name]);
  }

  /** Names of the Worker's secrets, or null when the Worker does not exist yet. */
  async secretNames(): Promise<string[] | null> {
    const args = ["secret", "list", "--format", "json", ...this.config()];
    const res = await this.exec(args);
    if (res.code !== 0) {
      if (/Worker ".*" not found|\b10007\b/.test(`${res.stdout}\n${res.stderr}`)) return null;
      throw new WranglerError(args, res);
    }
    return parseJsonOutput<Array<{ name: string }>>(res.stdout).map((s) => s.name);
  }

  /** Run SQL on the remote D1 database; one result set per statement. */
  async d1Execute(command: string): Promise<Array<Array<Record<string, unknown>>>> {
    const res = await this.ok(["d1", "execute", D1_BINDING, "--remote", "--json", "--yes", "--command", command, ...this.config()]);
    const out = parseJsonOutput<Array<{ results?: Array<Record<string, unknown>> }>>(res.stdout);
    return out.map((r) => r.results ?? []);
  }

  /** Migration files not yet applied to the remote D1 database. */
  async migrationsPending(): Promise<string[]> {
    const res = await this.ok(["d1", "migrations", "list", D1_BINDING, "--remote", ...this.config()]);
    if (/No migrations to apply/i.test(res.stdout)) return [];
    return [...new Set(res.stdout.match(/\b\d{4}_[\w-]+\.sql\b/g) ?? [])];
  }

  async migrationsApply(): Promise<void> {
    await this.ok(["d1", "migrations", "apply", D1_BINDING, "--remote", "--force", ...this.config()]);
  }

  async d1Export(outputFile: string): Promise<void> {
    await this.ok(["d1", "export", D1_BINDING, "--remote", "--skip-confirmation", "--output", outputFile, ...this.config()]);
  }

  async deploy(opts: { secretsFile?: string } = {}): Promise<DeployResult> {
    const args = ["deploy", ...this.config()];
    if (opts.secretsFile) args.push("--secrets-file", opts.secretsFile);
    const res = await this.ok(args);
    const output = `${res.stdout}\n${res.stderr}`;
    const versionId = /Current Version ID:\s*([0-9a-f-]{8,})/i.exec(output)?.[1] ?? null;
    const urls = [...new Set(output.match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [])];
    return { versionId, urls, output };
  }

  /** Roll the Worker back to a version (the previous one when no id is given). */
  async rollback(versionId: string | null, message: string): Promise<void> {
    const args = ["rollback"];
    if (versionId) args.push(versionId);
    args.push("--yes", "--message", message, ...this.config());
    await this.ok(args);
  }
}
