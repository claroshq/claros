/**
 * Provider resolution helper - tenant lookup through llm_configs decrypt to
 * a constructed OpenAICompatibleProvider.
 *
 * Lives in packages/worker because it touches the database (llm_configs table)
 * and the crypto envelope (@claros/adapters decrypt). brain-oss must not gain
 * any knowledge of tenants, llm_configs, or encryption; it receives an
 * already-constructed LlmProvider as a parameter.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import { decrypt, parseEncryptionKey } from "@claros/adapters";
import { OpenAICompatibleProvider, type LlmProvider, type LlmProviderConfig } from "@claros/brain-oss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** Successful provider resolution */
export interface ProviderResolved {
  ok: true;
  provider: LlmProvider;
}

/** Failed provider resolution with a human-readable reason */
export interface ProviderResolutionFailure {
  ok: false;
  reason: string;
}

export type ProviderResolutionResult = ProviderResolved | ProviderResolutionFailure;

// ---------------------------------------------------------------------------
// resolveTenantProvider()
// ---------------------------------------------------------------------------

/**
 * Resolve a tenant's active LLM provider.
 *
 * Steps:
 * 1. Read the tenant's active llm_configs row.
 * 2. Read ENCRYPTION_KEY from the environment.
 * 3. Decrypt the config envelope.
 * 4. Construct and return an OpenAICompatibleProvider.
 *
 * Returns a ProviderResolutionFailure with a descriptive reason on any failure.
 * The caller (compile worker, content worker) writes the reason to the
 * relevant error field and returns early.
 */
export async function resolveTenantProvider(
  db: Db,
  tenantId: string,
): Promise<ProviderResolutionResult> {
  // 1. Read the tenant's active LLM config
  const llmConfig = await storeFor(db).workerProviderResolver.getActiveLlmConfig(tenantId);

  if (llmConfig === null) {
    return {
      ok: false,
      reason:
        "No LLM configuration found. Add an LLM provider in Settings before compiling flows.",
    };
  }

  // 2. Read ENCRYPTION_KEY
  const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
  if (!encryptionKeyEnv) {
    return {
      ok: false,
      reason:
        "ENCRYPTION_KEY environment variable is not set. Required for decrypting LLM credentials.",
    };
  }

  // 3. Decrypt the config envelope
  let providerConfig: LlmProviderConfig;
  try {
    const key = parseEncryptionKey(encryptionKeyEnv);
    const decrypted = decrypt(llmConfig.config, key);
    providerConfig = JSON.parse(decrypted) as LlmProviderConfig;
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to decrypt LLM configuration: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Construct provider; P5b: every call's tokens count towards the
  // product's daily usage (settings.llm_daily_token_budget).
  const provider = meteredProvider(new OpenAICompatibleProvider(providerConfig), (tokens) =>
    storeFor(db).workerProviderResolver.addLlmTokens({ tenantId, day: utcDay(new Date()), tokens }),
  );

  return { ok: true, provider };
}

/** The UTC date "YYYY-MM-DD" of a time (the LLM budget's day). */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A provider that reports the total tokens of every successful call. Recording failures are ignored. */
export function meteredProvider(inner: LlmProvider, record: (tokens: number) => Promise<void>): LlmProvider {
  return {
    async complete(opts) {
      const r = await inner.complete(opts);
      const u = r.usage;
      const tokens = u ? (u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)) : 0;
      if (tokens > 0) await record(tokens).catch(() => {});
      return r;
    },
  };
}

/**
 * P5b: whether the product is at or over its daily LLM token budget
 * (settings.llm_daily_token_budget, a UTC day). No budget: never.
 */
export async function overLlmBudget(db: Db, tenantId: string, settings: Record<string, unknown> | null | undefined, now: Date): Promise<boolean> {
  const budget = settings?.llm_daily_token_budget;
  if (typeof budget !== "number" || !(budget > 0)) return false;
  const used = await storeFor(db).workerProviderResolver.getLlmTokens({ tenantId, day: utcDay(now) });
  return used >= budget;
}
