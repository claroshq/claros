/**
 * Shared embedding client - resolves a tenant's embedding provider config and
 * calls the OpenAI-compatible /embeddings endpoint.
 *
 * Used by:
 *   - embed-kb.ts (indexing: generate embeddings for kb_entries rows)
 *   - context-kb.ts (querying: embed the query text for similarity search)
 *
 * Keeping the provider resolution and HTTP call in one place ensures the
 * same retry policy, error classification, and model default apply to both
 * indexing and querying paths. Model consistency is critical: a query vector
 * produced by a different model than the stored entry vectors is incomparable.
 */
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { llmConfigs } from "@claros/db/schema";
import { decrypt, parseEncryptionKey } from "@claros/adapters";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** Default embedding model when embedding_model is absent from the LLM config. */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * The decrypted config shape. Extends the base LlmProviderConfig with the
 * optional embedding_model field introduced in task 22.
 */
interface EmbeddingProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  embedding_model?: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when the embedding provider returns a non-retryable HTTP error
 * (400/401/403/404). These indicate a configuration problem (bad API key,
 * wrong model name) that retrying will not fix.
 *
 * Callers catch this and record it as a permanent failure on the entity row
 * rather than propagating to pg-boss for retry.
 */
export class EmbeddingPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingPermanentError";
  }
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface EmbeddingProviderResolved {
  ok: true;
  apiKey: string;
  baseUrl: string;
  embeddingModel: string;
}

export interface EmbeddingProviderFailure {
  ok: false;
  reason: string;
  /** true = permanent config error; false = should be treated as transient */
  permanent: boolean;
}

export type EmbeddingProviderResult = EmbeddingProviderResolved | EmbeddingProviderFailure;

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the embedding provider configuration for a tenant.
 *
 * Reads the tenant's active llm_configs row, decrypts it, and returns the
 * connection parameters needed for an embedding call.
 *
 * Returns a failure descriptor (not a thrown error) so callers can decide
 * whether to record a permanent failure, retry, or skip silently.
 *
 * permanent=true failures: missing config, missing ENCRYPTION_KEY, decrypt error.
 * These are configuration problems that retrying will not fix.
 */
export async function resolveEmbeddingProvider(
  db: Db,
  tenantId: string,
): Promise<EmbeddingProviderResult> {
  // Read the tenant's active LLM config
  const llmRows = await db
    .select()
    .from(llmConfigs)
    .where(and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)))
    .limit(1);

  if (llmRows.length === 0) {
    return {
      ok: false,
      permanent: true,
      reason:
        `No active LLM configuration found for tenant ${tenantId}. ` +
        "Add an LLM provider in Settings before KB entries can be embedded.",
    };
  }

  const llmConfig = llmRows[0]!;

  const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
  if (!encryptionKeyEnv) {
    return {
      ok: false,
      permanent: true,
      reason: "ENCRYPTION_KEY environment variable is not set.",
    };
  }

  let providerConfig: EmbeddingProviderConfig;
  try {
    const key = parseEncryptionKey(encryptionKeyEnv);
    const decrypted = decrypt(llmConfig.config, key);
    providerConfig = JSON.parse(decrypted) as EmbeddingProviderConfig;
  } catch (err) {
    return {
      ok: false,
      permanent: true,
      reason: `Failed to decrypt LLM configuration: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    apiKey: providerConfig.apiKey,
    baseUrl: providerConfig.baseUrl.replace(/\/+$/, ""),
    embeddingModel: providerConfig.embedding_model ?? DEFAULT_EMBEDDING_MODEL,
  };
}

// ---------------------------------------------------------------------------
// Embedding call
// ---------------------------------------------------------------------------

/**
 * Call the OpenAI-compatible /embeddings endpoint and return the vector.
 *
 * Retry policy:
 *   - 429 (rate limit) and 5xx (server error): exponential backoff, up to 3 retries.
 *   - 400/401/403/404: throws EmbeddingPermanentError immediately (no retries).
 *   - Network errors: retried.
 *   - After all retries exhausted: throws a plain Error.
 *
 * @param baseUrl - Provider base URL, no trailing slash.
 * @param apiKey  - API key for Authorization: Bearer.
 * @param model   - Embedding model identifier.
 * @param input   - Text to embed.
 */
export async function callEmbedding(
  baseUrl: string,
  apiKey: string,
  model: string,
  input: string,
): Promise<number[]> {
  const url = `${baseUrl}/embeddings`;
  const body = { model, input };

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;

  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await sleep(delay);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network error - transient, retry.
      lastErr = new Error(
        `[embedding] network error calling ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (!response.ok) {
      const statusCode = response.status;
      const responseBody = await response.text().catch(() => "");
      const retryable = statusCode === 429 || statusCode >= 500;
      const msg = `[embedding] endpoint returned HTTP ${statusCode}: ${responseBody.slice(0, 500)}`;

      if (!retryable) {
        // Permanent: bad API key, wrong model name, request format error.
        throw new EmbeddingPermanentError(msg);
      }
      lastErr = new Error(msg);
      continue;
    }

    const json = await response.json() as {
      data?: Array<{ embedding?: number[] }>;
    };

    const embedding = json.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error(`[embedding] endpoint response missing data[0].embedding`);
    }

    return embedding;
  }

  throw lastErr ?? new Error(`[embedding] request failed after retries`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
