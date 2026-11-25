/**
 * `claros apply -f claros.config.json [--dry-run]`: send a product's config
 * document to PUT /v1/config (G2) with an admin key that has the `config`
 * scope, and print the changes.
 *
 * Where: --url, else CLAROS_URL, else the host of the instance --name
 * (state file written by `claros deploy`). Key: --key, else
 * CLAROS_ADMIN_KEY. The product is the admin key's product.
 */
import { readFileSync } from "node:fs";
import type { Context } from "./ops.js";
import { DEFAULT_INSTANCE, loadState } from "./state.js";

export interface ApplyOptions {
  file?: string;
  dryRun?: boolean;
  url?: string;
  key?: string;
  name?: string;
}

interface Change {
  kind: string;
  key: string;
  action: string;
  fields?: string[];
}

export async function applyConfig(ctx: Context, opts: ApplyOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!opts.file) {
    ctx.io.warn("claros apply needs -f <file> (a claros.config.json).");
    return 2;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(opts.file, "utf8"));
  } catch (err) {
    ctx.io.warn(`${opts.file}: ${(err as Error).message}`);
    return 2;
  }
  const key = opts.key ?? env.CLAROS_ADMIN_KEY;
  if (!key) {
    ctx.io.warn("No admin key: pass --key or set CLAROS_ADMIN_KEY (an admin key with the config scope).");
    return 2;
  }
  let base = opts.url ?? env.CLAROS_URL;
  if (!base) {
    const state = loadState(ctx.configDir, opts.name ?? DEFAULT_INSTANCE);
    if (state?.host) base = `https://${state.host}`;
  }
  if (!base) {
    ctx.io.warn("No Claros URL: pass --url, set CLAROS_URL, or deploy an instance with `claros deploy` (--name).");
    return 2;
  }
  const url = `${base.replace(/\/+$/, "")}/v1/config${opts.dryRun ? "?dry_run=1" : ""}`;
  const res = await ctx.fetch(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(doc),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    errors?: string[];
    warnings?: string[];
    issues?: Array<{ path: string; message: string }>;
    changes?: Change[];
    config_version?: number;
    webhook_secrets?: Record<string, string>;
  };
  if (res.status !== 200) {
    ctx.io.warn(`${res.status}: ${body.error ?? "request failed"}`);
    for (const e of body.errors ?? []) ctx.io.log(`  - ${e}`);
    for (const i of body.issues ?? []) ctx.io.log(`  - ${i.path || "(document)"}: ${i.message}`);
    return 1;
  }
  for (const w of body.warnings ?? []) ctx.io.warn(w);
  const changes = body.changes ?? [];
  if (changes.length === 0) {
    ctx.io.log(`No changes (config version ${body.config_version}).`);
  } else {
    ctx.io.log(opts.dryRun ? `Would apply ${changes.length} change(s):` : `Applied ${changes.length} change(s), config version ${body.config_version}:`);
    for (const c of changes) {
      ctx.io.log(`  ${c.action.padEnd(7)} ${c.kind} ${c.key}${c.fields && c.fields.length > 0 ? ` (${c.fields.join(", ")})` : ""}`);
    }
  }
  for (const [slug, secret] of Object.entries(body.webhook_secrets ?? {})) {
    ctx.io.log(`Webhook ${slug} signing secret (shown once, store it with the receiver): ${secret}`);
  }
  return 0;
}
