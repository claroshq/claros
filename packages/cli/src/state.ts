/**
 * Local state cache per instance: ~/.config/claros/<name>.json (mode 600).
 *
 * Everything in it except generated secrets can be found again on
 * Cloudflare by name, so a missing cache is fine. Generated secrets are
 * written here so the operator can back them up; they are never read back
 * to overwrite a secret that exists on the Worker.
 *
 * Per-instance files live next to it in ~/.config/claros/<name>/:
 * the generated wrangler.jsonc and backups/.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SECRET_NAMES = ["ENCRYPTION_KEY", "UNSUBSCRIBE_SIGNING_KEY"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export interface InstanceState {
  name: string;
  accountId: string;
  workerName: string;
  d1Name: string;
  d1Id: string | null;
  queues: { jobs: string; dlq: string };
  /** Public host of the instance (custom domain or workers.dev host). */
  host: string | null;
  /** True when --domain was given (the host is a custom domain). */
  customDomain: boolean;
  /** Claros version last deployed by this CLI. */
  deployedVersion: string | null;
  /** Worker version id of the last deploy (for rollback). */
  versionId: string | null;
  /** Hash of the last deployed wrangler.jsonc. */
  configHash: string | null;
  /** Secrets this CLI generated. Back this file up. */
  generatedSecrets: Partial<Record<SecretName, string>>;
}

/** Instance names: lowercase letters, digits and hyphens. */
export const INSTANCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const DEFAULT_INSTANCE = "default";

/** ~/.config/claros (or $XDG_CONFIG_HOME/claros). */
export function defaultConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "claros");
}

export function statePath(configDir: string, name: string): string {
  return join(configDir, `${name}.json`);
}

/** ~/.config/claros/<name>/ (created on demand, mode 700). */
export function instanceDir(configDir: string, name: string): string {
  const dir = join(configDir, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Resource names derived from the instance name. */
export function resourceNames(name: string): Pick<InstanceState, "workerName" | "d1Name" | "queues"> {
  return {
    workerName: `claros-${name}`,
    d1Name: `claros-${name}`,
    queues: { jobs: `claros-${name}-jobs`, dlq: `claros-${name}-jobs-dlq` },
  };
}

export function newState(name: string, accountId: string): InstanceState {
  return {
    name,
    accountId,
    ...resourceNames(name),
    d1Id: null,
    host: null,
    customDomain: false,
    deployedVersion: null,
    versionId: null,
    configHash: null,
    generatedSecrets: {},
  };
}

export function loadState(configDir: string, name: string): InstanceState | null {
  const path = statePath(configDir, name);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}). Fix or move it; everything but generated secrets is found again on Cloudflare.`);
  }
  const s = raw as Partial<InstanceState>;
  if (typeof s !== "object" || s === null || s.name !== name || typeof s.accountId !== "string") {
    throw new Error(`${path} does not look like a Claros instance state file for "${name}".`);
  }
  const base = newState(name, s.accountId);
  return {
    ...base,
    ...s,
    queues: { ...base.queues, ...(s.queues ?? {}) },
    generatedSecrets: { ...(s.generatedSecrets ?? {}) },
  };
}

/** Write the state file with mode 600 (and keep it 600 if it existed). */
export function saveState(configDir: string, state: InstanceState): string {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const path = statePath(configDir, state.name);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
