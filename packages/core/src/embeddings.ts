/**
 * Embedding providers for the knowledge base.
 *
 * Embeddings have their own provider, separate from the chat LLM: a product
 * can draft with Anthropic (no embeddings API) and embed with OpenAI or any
 * OpenAI-compatible /embeddings endpoint. Embeddings are optional. Without
 * them, kb_context falls back to word matching; pinned entries, kb_select and
 * kb_ref never needed them.
 *
 * Every vector must have EMBEDDING_DIMENSIONS components: the Postgres column
 * is vector(1536) and stored vectors from different models are incomparable.
 */

/** Dimensionality of kb_entries.embedding (Postgres vector(1536)). */
export const EMBEDDING_DIMENSIONS = 1536;

/** Embedding provider identifiers. Both use the OpenAI /embeddings API shape. */
export const KNOWN_EMBEDDING_PROVIDERS = ["openai", "custom"] as const;
export type KnownEmbeddingProvider = (typeof KNOWN_EMBEDDING_PROVIDERS)[number];

export interface EmbeddingProviderDefaults {
  /** Base URL of the OpenAI-compatible API. null = must be given. */
  baseUrl: string | null;
  /** Embedding model. null = must be given. */
  model: string | null;
  /** Whether the endpoint works without an API key (local servers). */
  keyOptional: boolean;
}

export const EMBEDDING_PROVIDER_DEFAULTS: Record<KnownEmbeddingProvider, EmbeddingProviderDefaults> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", keyOptional: false },
  custom: { baseUrl: null, model: null, keyOptional: true },
};

export function isKnownEmbeddingProvider(v: string): v is KnownEmbeddingProvider {
  return (KNOWN_EMBEDDING_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Chat LLM providers that serve no usable embeddings: Anthropic has no
 * embeddings API, Ollama's embedding models do not produce 1536 dimensions.
 * Before embedding_configs existed the embedding client reused the chat
 * config for every provider; for these two that only ever returned errors,
 * so an LLM config of these providers (without an explicit embedding_model)
 * is no longer used for embeddings.
 */
export const LLM_PROVIDERS_WITHOUT_EMBEDDINGS: readonly string[] = ["anthropic", "ollama"];

/** Decrypted envelope of an embedding_configs row. */
export interface EmbeddingConfigEnvelope {
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * Whether requests carry `dimensions: 1536`. Set at save time: true when
   * the endpoint accepted the parameter, false when it rejected it and
   * answered 1536 dimensions without it.
   */
  sendDimensions: boolean;
}
