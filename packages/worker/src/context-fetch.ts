/**
 * Context-fetch hook (G11): at render time, a step's `context` sources are
 * called with a signed POST and their data becomes part of the message.
 *
 * Request: POST <data source url>, JSON body
 *   {source, mode, limit, product, contact: {external_id, email, traits},
 *    flow: {slug}, step: {order}, message_id}
 * signed with Standard Webhooks headers (webhook-id, webhook-timestamp,
 * webhook-signature) using the data source secret: `secret` from the config
 * (stored encrypted as secret_enc) or the environment variable named by
 * `secret_ref` / `secret_env`. A source without a usable secret is an error
 * (fail closed). Response: {data, empty}; `empty` defaults to "data is null,
 * an empty object or an empty list". Timeout: timeout_ms, default 5 s.
 *
 * The snapshot ({<source>: data}) is stored on the message
 * (context_snapshot), shown in approvals, available to templates as
 * {{context.<source>...}} (with Mustache sections) and to the brain as a
 * context section. Links in returned data go into the mail as given; the
 * drain's UTM tagging (G6) applies to them like to any other link on a
 * tracked domain.
 */
import { decrypt, parseEncryptionKey } from "@claros/adapters";
import { signWebhook, type StepContext } from "@claros/core";

export const CONTEXT_DEFAULT_TIMEOUT_MS = 5000;

export interface DataSourceConfig {
  url?: string;
  secret_enc?: string;
  secret_ref?: string;
  secret_env?: string;
  timeout_ms?: number;
}

export interface ContextRequest {
  settings: Record<string, unknown>;
  product: string;
  contact: { external_id: string; email: string | null; traits: Record<string, unknown> };
  flowSlug: string | null;
  stepOrder: number;
  messageId: string;
  entries: StepContext[];
  now?: Date;
  fetch?: typeof fetch;
}

export type ContextResult =
  | { ok: true; snapshot: Record<string, unknown>; empty: boolean; emptySources: string[] }
  | { ok: false; error: string };

function sourceSecret(src: DataSourceConfig): string | null {
  if (typeof src.secret_enc === "string") {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) return null;
    try {
      return decrypt(src.secret_enc, parseEncryptionKey(key));
    } catch {
      return null;
    }
  }
  const ref = src.secret_ref ?? src.secret_env;
  if (typeof ref === "string" && ref.length > 0) {
    const v = process.env[ref];
    return typeof v === "string" && v.length > 0 ? v : null;
  }
  return null;
}

function isEmptyData(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === "object") return Object.keys(data as object).length === 0;
  return false;
}

/** Fetch every context entry of a step. Fails on the first source error. */
export async function fetchStepContext(req: ContextRequest): Promise<ContextResult> {
  const sources = (req.settings.data_sources ?? {}) as Record<string, DataSourceConfig>;
  const doFetch = req.fetch ?? fetch;
  const snapshot: Record<string, unknown> = {};
  const emptySources: string[] = [];
  for (const entry of req.entries) {
    const src = sources[entry.source];
    if (!src || typeof src.url !== "string" || !/^https?:\/\//.test(src.url)) {
      return { ok: false, error: `data source '${entry.source}' is not configured` };
    }
    const secret = sourceSecret(src);
    if (!secret) return { ok: false, error: `data source '${entry.source}' has no usable secret` };
    const body = JSON.stringify({
      source: entry.source,
      mode: entry.mode ?? null,
      limit: entry.limit ?? null,
      product: req.product,
      contact: req.contact,
      flow: { slug: req.flowSlug },
      step: { order: req.stepOrder },
      message_id: req.messageId,
    });
    const headers = signWebhook({ id: `ctx_${req.messageId}_${entry.source}`, timestamp: req.now ?? new Date(), body, secret });
    const timeout = src.timeout_ms ?? CONTEXT_DEFAULT_TIMEOUT_MS;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    let res: Response;
    try {
      res = await doFetch(src.url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body, signal: ac.signal });
    } catch (err) {
      clearTimeout(timer);
      const msg = ac.signal.aborted ? `timed out after ${timeout} ms` : err instanceof Error ? err.message : String(err);
      return { ok: false, error: `data source '${entry.source}': ${msg}` };
    }
    let parsed: unknown;
    try {
      if (!res.ok) {
        clearTimeout(timer);
        return { ok: false, error: `data source '${entry.source}' answered ${res.status}` };
      }
      parsed = await res.json();
    } catch {
      clearTimeout(timer);
      return { ok: false, error: `data source '${entry.source}' returned invalid JSON` };
    }
    clearTimeout(timer);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: `data source '${entry.source}' returned no {data, empty} object` };
    }
    const { data, empty } = parsed as { data?: unknown; empty?: unknown };
    snapshot[entry.source] = data ?? null;
    if (empty === true || (empty !== false && isEmptyData(data))) emptySources.push(entry.source);
  }
  return { ok: true, snapshot, empty: emptySources.length > 0, emptySources };
}

/** The snapshot as a brain context section (JSON, size-capped). */
export function contextSection(snapshot: Record<string, unknown>, maxChars = 6000): string {
  const json = JSON.stringify(snapshot, null, 1);
  return json.length > maxChars ? `${json.slice(0, maxChars)}\n(truncated)` : json;
}
