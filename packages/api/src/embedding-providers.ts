/**
 * Embedding provider defaults and endpoint verification.
 *
 * Embeddings have their own provider (embedding_configs), separate from the
 * chat LLM: Anthropic, a chat provider, has no embeddings API. The settings
 * form asks for a provider and a key; base URL and model follow from the
 * provider (EMBEDDING_PROVIDER_DEFAULTS in @claros/core) and are accepted as
 * overrides, required for "custom".
 *
 * Verification: PUT /v1/settings/embeddings embeds one word before storing
 * anything and requires a vector of EMBEDDING_DIMENSIONS components, the size
 * of the Postgres column. It first sends `dimensions: 1536` (models that can
 * shorten their vectors, such as text-embedding-3-large, need it); when the
 * endpoint rejects the parameter with 400 or 422 it retries once without it.
 * Which of the two worked is stored (sendDimensions) and used for every call.
 */
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_PROVIDER_DEFAULTS,
  type KnownEmbeddingProvider,
} from "@claros/core";

export interface EmbeddingConfigInput {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
}

export interface EffectiveEmbeddingConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type ResolveEmbeddingConfigResult =
  | { ok: true; config: EffectiveEmbeddingConfig }
  | { ok: false; error: string };

/** Apply per-provider defaults to raw form input. Overrides win when present. */
export function resolveEmbeddingConfig(
  provider: KnownEmbeddingProvider,
  input: EmbeddingConfigInput,
): ResolveEmbeddingConfigResult {
  const defaults = EMBEDDING_PROVIDER_DEFAULTS[provider];
  const apiKey = input.apiKey?.trim() ?? "";
  if (apiKey === "" && !defaults.keyOptional) {
    return { ok: false, error: `An API key is required for ${provider}.` };
  }
  const baseUrl = (input.baseUrl?.trim() || defaults.baseUrl || "").replace(/\/+$/, "");
  if (baseUrl === "") {
    return { ok: false, error: "A base URL is required for a custom OpenAI-compatible endpoint." };
  }
  const model = input.model?.trim() || defaults.model || "";
  if (model === "") {
    return { ok: false, error: "A model is required for a custom OpenAI-compatible endpoint." };
  }
  return { ok: true, config: { apiKey, baseUrl, model } };
}

/** Verification call timeout. Slow endpoints must not hang the form. */
export const EMBEDDING_VERIFY_TIMEOUT_MS = 10_000;

export type VerifyEmbeddingResult =
  | { ok: true; sendDimensions: boolean }
  | {
      ok: false;
      kind: "http" | "timeout" | "unreachable" | "dimensions" | "response";
      /** HTTP status when the provider answered, null otherwise. */
      status: number | null;
      /** What the provider said, or what was wrong with the answer. */
      detail: string;
    };

type Attempt =
  | { ok: true; length: number }
  | { ok: false; kind: "http" | "timeout" | "unreachable" | "response"; status: number | null; detail: string };

async function embedOnce(config: EffectiveEmbeddingConfig, withDimensions: boolean): Promise<Attempt> {
  const body = {
    model: config.model,
    input: "ping",
    ...(withDimensions ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
  };
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EMBEDDING_VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout =
      (err instanceof Error && err.name === "TimeoutError") || /timed?\s*out/i.test(message);
    const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
    return {
      ok: false,
      kind: isTimeout ? "timeout" : "unreachable",
      status: null,
      detail: cause?.code ? `${message} (${cause.code})` : message,
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, kind: "http", status: response.status, detail: text.slice(0, 500) };
  }
  const json = (await response.json().catch(() => null)) as { data?: Array<{ embedding?: unknown }> } | null;
  const embedding = json?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    return { ok: false, kind: "response", status: response.status, detail: "The answer has no data[0].embedding array." };
  }
  return { ok: true, length: embedding.length };
}

/**
 * Verify an embeddings endpoint (see the module header). A single attempt
 * per variant, no backoff: a save-time check should fail fast and tell the
 * truth.
 */
export async function verifyEmbeddingEndpoint(config: EffectiveEmbeddingConfig): Promise<VerifyEmbeddingResult> {
  let sendDimensions = true;
  let attempt = await embedOnce(config, true);
  if (!attempt.ok && attempt.kind === "http" && (attempt.status === 400 || attempt.status === 422)) {
    const without = await embedOnce(config, false);
    if (without.ok) {
      sendDimensions = false;
      attempt = without;
    }
  }
  if (!attempt.ok) return attempt;
  if (attempt.length !== EMBEDDING_DIMENSIONS) {
    return {
      ok: false,
      kind: "dimensions",
      status: null,
      detail:
        `The model "${config.model}" returned ${attempt.length} dimensions; Claros stores ` +
        `${EMBEDDING_DIMENSIONS}. Choose a model that returns ${EMBEDDING_DIMENSIONS} dimensions ` +
        `(OpenAI text-embedding-3-small, or a model that accepts the dimensions parameter).`,
    };
  }
  return { ok: true, sendDimensions };
}
