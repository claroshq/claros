/**
 * Shared embedding client - resolves a tenant's embedding provider config and
 * calls the OpenAI-compatible /embeddings endpoint.
 *
 * The provider comes from embedding_configs (Settings, Embeddings) or, for
 * installs that predate it, from an embeddings-capable llm_configs row; see
 * resolveEmbeddingProvider.
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
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import { decrypt, parseEncryptionKey } from "@claros/adapters";
import {
  EMBEDDING_DIMENSIONS,
  LLM_PROVIDERS_WITHOUT_EMBEDDINGS,
  type EmbeddingConfigEnvelope,
} from "@claros/core";

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
  /** Send `dimensions` with this value, or undefined to leave it out. */
  dimensions: number | undefined;
  /** Where the settings came from. */
  source: "embedding_config" | "llm_config";
}

export interface EmbeddingProviderFailure {
  ok: false;
  reason: string;
  /** true = permanent config error; false = should be treated as transient */
  permanent: boolean;
  /**
   * true = no embedding provider is configured. Not an error: the knowledge
   * base works without embeddings (kb_context falls back to word matching).
   */
  notConfigured?: boolean;
}

export type EmbeddingProviderResult = EmbeddingProviderResolved | EmbeddingProviderFailure;

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the embedding provider configuration for a tenant.
 *
 * Order:
 *   1. The tenant's active embedding_configs row (Settings, Embeddings).
 *   2. The active llm_configs row, as before embedding_configs existed, when
 *      it can serve embeddings: an explicit embedding_model, or a provider
 *      other than those in LLM_PROVIDERS_WITHOUT_EMBEDDINGS (Anthropic,
 *      Ollama). Installs that embed with their OpenAI chat key keep working.
 *   3. Otherwise notConfigured: not an error.
 *
 * Returns a failure descriptor (not a thrown error) so callers can decide
 * whether to record a permanent failure, retry, or skip silently.
 *
 * permanent=true failures: missing ENCRYPTION_KEY, decrypt error. These are
 * configuration problems that retrying will not fix.
 */
export async function resolveEmbeddingProvider(
  db: Db,
  tenantId: string,
): Promise<EmbeddingProviderResult> {
  const store = storeFor(db).workerEmbeddingClient;

  const embeddingRow = await store.getActiveEmbeddingConfig(tenantId);
  if (embeddingRow) {
    const decrypted = decryptEnvelope<EmbeddingConfigEnvelope>(embeddingRow.config, "embedding");
    if (!decrypted.ok) return decrypted;
    const c = decrypted.value;
    return {
      ok: true,
      apiKey: c.apiKey,
      baseUrl: c.baseUrl.replace(/\/+$/, ""),
      embeddingModel: c.model,
      dimensions: c.sendDimensions ? EMBEDDING_DIMENSIONS : undefined,
      source: "embedding_config",
    };
  }

  const llmConfig = await store.getActiveLlmConfig(tenantId);
  if (llmConfig !== null) {
    const decrypted = decryptEnvelope<EmbeddingProviderConfig>(llmConfig.config, "LLM");
    if (!decrypted.ok) return decrypted;
    const c = decrypted.value;
    if (c.embedding_model || !LLM_PROVIDERS_WITHOUT_EMBEDDINGS.includes(llmConfig.provider)) {
      return {
        ok: true,
        apiKey: c.apiKey,
        baseUrl: c.baseUrl.replace(/\/+$/, ""),
        embeddingModel: c.embedding_model ?? DEFAULT_EMBEDDING_MODEL,
        dimensions: undefined,
        source: "llm_config",
      };
    }
  }

  return {
    ok: false,
    permanent: true,
    notConfigured: true,
    reason:
      `No embedding provider configured for tenant ${tenantId}. ` +
      "Add one in Settings, Embeddings to enable semantic search; until then " +
      "the knowledge base is searched by word matching.",
  };
}

function decryptEnvelope<T>(
  envelope: string,
  what: string,
): { ok: true; value: T } | EmbeddingProviderFailure {
  const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
  if (!encryptionKeyEnv) {
    return { ok: false, permanent: true, reason: "ENCRYPTION_KEY environment variable is not set." };
  }
  try {
    const key = parseEncryptionKey(encryptionKeyEnv);
    return { ok: true, value: JSON.parse(decrypt(envelope, key)) as T };
  } catch (err) {
    return {
      ok: false,
      permanent: true,
      reason: `Failed to decrypt ${what} configuration: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
 * @param dimensions - Sent as `dimensions` when given (models that can
 *                     shorten their vectors, such as text-embedding-3-*).
 */
export async function callEmbedding(
  baseUrl: string,
  apiKey: string,
  model: string,
  input: string,
  dimensions?: number,
): Promise<number[]> {
  const url = `${baseUrl}/embeddings`;
  const body = { model, input, ...(dimensions !== undefined ? { dimensions } : {}) };

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
