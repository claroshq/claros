/**
 * Display-only mirror of the LLM provider defaults.
 *
 * Source of truth: packages/api/src/llm-providers.ts (LLM_PROVIDER_DEFAULTS).
 * The server applies these defaults at write time; this copy exists so the
 * form can show what will be used before saving. After a save, the values
 * rendered come from the server response, not from this table.
 */

export interface LlmProviderDisplayDefaults {
  baseUrl: string | null;
  model: string | null;
  embeddingModel: string | null;
  keyOptional: boolean;
}

export const LLM_PROVIDER_DEFAULTS: Record<string, LlmProviderDisplayDefaults> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    embeddingModel: "text-embedding-3-small",
    keyOptional: false,
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-6",
    embeddingModel: null,
    keyOptional: false,
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    model: "llama3",
    embeddingModel: null,
    keyOptional: true,
  },
  custom: {
    baseUrl: null,
    model: null,
    embeddingModel: null,
    keyOptional: true,
  },
};

export function llmDefaultsFor(provider: string): LlmProviderDisplayDefaults {
  return LLM_PROVIDER_DEFAULTS[provider] ?? {
    baseUrl: null,
    model: null,
    embeddingModel: null,
    keyOptional: true,
  };
}
