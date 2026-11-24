/**
 * LLM provider defaults and credential verification.
 *
 * The settings form asks a person for two things: which provider they use
 * and their API key. Everything else is a product decision encoded here:
 * the base URL follows from the provider, and the model is chosen by us
 * (a person should not have to know what a base URL is, and model choice
 * is ours to make and to change). Rare overrides arrive through the
 * advanced section of the form and are honoured verbatim.
 *
 * Verification: PUT /v1/settings/llm verifies the key before storing, with
 * the cheapest real call every OpenAI-compatible endpoint supports - a
 * 1-token chat completion. A wrong key is reported at save time instead of
 * surfacing hours later as failed compiles and stuck messages.
 *
 * display-only mirror of LLM_PROVIDER_DEFAULTS in
 * apps/dashboard/src/llm-defaults.ts; this file is the source of truth.
 */
/**
 * Known LLM provider identifiers. All use the OpenAI-compatible API shape.
 * "custom" is for any OpenAI-compatible endpoint not listed here.
 */
export const KNOWN_LLM_PROVIDERS = ["openai", "anthropic", "ollama", "custom"] as const;
export type KnownLlmProvider = (typeof KNOWN_LLM_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export interface LlmProviderDefaults {
  /** Base URL for the provider's OpenAI-compatible endpoint. null = must be asked. */
  baseUrl: string | null;
  /** Chat model used for compile, decide, draft, and assess. null = must be asked. */
  model: string | null;
  /**
   * Embedding model used for KB indexing and similarity queries. null = no
   * native embedding endpoint; the embedding client falls back to its own
   * default (text-embedding-3-small), which only OpenAI serves.
   */
  embeddingModel: string | null;
  /** Whether a local install of this provider works without an API key. */
  keyOptional: boolean;
}

export const LLM_PROVIDER_DEFAULTS: Record<KnownLlmProvider, LlmProviderDefaults> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    // gpt-4o-mini: decide/draft/assess run per message, so cost dominates;
    // compile is Zod-validated, so a weaker model fails safe rather than
    // corrupting. Operators who want a stronger model can override it.
    model: "gpt-4o-mini",
    embeddingModel: "text-embedding-3-small",
    keyOptional: false,
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-6",
    // Anthropic's OpenAI-compatible layer has no embeddings endpoint.
    embeddingModel: null,
    keyOptional: false,
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    model: "llama3",
    // Ollama embedding models do not produce the 1536-dimension vectors the
    // schema requires; no default is offered.
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

export function isKnownLlmProvider(v: string): v is KnownLlmProvider {
  return (KNOWN_LLM_PROVIDERS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Effective config resolution
// ---------------------------------------------------------------------------

export interface LlmConfigInput {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  embeddingModel?: string | undefined;
}

/** The effective configuration after defaults are applied. */
export interface EffectiveLlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  embeddingModel: string | null;
  /** Which fields came from user override rather than our defaults. */
  overridden: Array<"base_url" | "model" | "embedding_model">;
}

export type ResolveLlmConfigResult =
  | { ok: true; config: EffectiveLlmConfig }
  | { ok: false; error: string };

/**
 * Apply per-provider defaults to raw form input. Overrides win when present.
 * Returns a human-readable error when a required value has no default
 * (custom endpoint without a base URL or model, keyless hosted provider).
 */
export function resolveLlmConfig(
  provider: KnownLlmProvider,
  input: LlmConfigInput,
): ResolveLlmConfigResult {
  const defaults = LLM_PROVIDER_DEFAULTS[provider];
  const overridden: EffectiveLlmConfig["overridden"] = [];

  const apiKey = input.apiKey?.trim() ?? "";
  if (apiKey === "" && !defaults.keyOptional) {
    return { ok: false, error: `An API key is required for ${provider}.` };
  }

  let baseUrl = input.baseUrl?.trim() ?? "";
  if (baseUrl !== "") {
    overridden.push("base_url");
  } else if (defaults.baseUrl !== null) {
    baseUrl = defaults.baseUrl;
  } else {
    return {
      ok: false,
      error: "A base URL is required for a custom OpenAI-compatible endpoint.",
    };
  }

  let model = input.model?.trim() ?? "";
  if (model !== "") {
    overridden.push("model");
  } else if (defaults.model !== null) {
    model = defaults.model;
  } else {
    return {
      ok: false,
      error: "A model is required for a custom OpenAI-compatible endpoint.",
    };
  }

  let embeddingModel: string | null = null;
  const embeddingInput = input.embeddingModel?.trim() ?? "";
  if (embeddingInput !== "") {
    embeddingModel = embeddingInput;
    overridden.push("embedding_model");
  } else {
    embeddingModel = defaults.embeddingModel;
  }

  return {
    ok: true,
    config: { apiKey, baseUrl, model, embeddingModel, overridden },
  };
}

// ---------------------------------------------------------------------------
// Credential verification
// ---------------------------------------------------------------------------

/** Verification call timeout. Slow endpoints must not hang the form. */
export const VERIFY_TIMEOUT_MS = 10_000;

export type VerifyLlmResult =
  | { ok: true }
  | {
      ok: false;
      kind: "http" | "timeout" | "unreachable";
      /** HTTP status when the provider answered, null otherwise. */
      status: number | null;
      /** What the provider said, or the network error message. */
      detail: string;
    };

/**
 * Verify credentials with the cheapest real call the OpenAI-compatible
 * surface supports: a 1-token chat completion. Every endpoint that can
 * serve compile/draft can serve this shape; GET /models is cheaper still
 * but is not part of the compatibility contract (Anthropic's layer does
 * not implement it).
 *
 * A single attempt, no retries: a save-time check should fail fast and
 * tell the truth, not hide a flapping endpoint behind backoff.
 */
export async function verifyLlmCredentials(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<VerifyLlmResult> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: config.model,
    messages: [{ role: "user", content: "ping" }],
    temperature: 0,
    max_tokens: 1,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout =
      (err instanceof Error && err.name === "TimeoutError") ||
      /timed?\s*out/i.test(message);
    // undici puts the useful code (ECONNREFUSED, ENOTFOUND, ...) on cause.
    const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
    const detail = cause?.code ? `${message} (${cause.code})` : message;
    return {
      ok: false,
      kind: isTimeout ? "timeout" : "unreachable",
      status: null,
      detail,
    };
  }

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    return {
      ok: false,
      kind: "http",
      status: response.status,
      detail: responseBody.slice(0, 500),
    };
  }

  return { ok: true };
}
