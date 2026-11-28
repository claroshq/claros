/**
 * OpenAI-compatible LLM provider implementation.
 *
 * Works with any endpoint that implements the /v1/chat/completions API shape:
 * OpenAI, Claude (Anthropic's OpenAI-compatible layer), Gemini (Google's
 * OpenAI-compat endpoint), Groq, Ollama, Azure OpenAI, vLLM, etc.
 *
 * JSON mode compatibility:
 *   The compile flow requests response_format: { type: "json_object" }.
 *   - OpenAI, Groq, Gemini (OpenAI-compat): honour this natively.
 *   - Claude (Anthropic): the compatibility layer rejects { type: "json_object" }
 *     with a 400 ("response_format.type: Input should be 'json_schema'"), so
 *     response_format is never sent to an anthropic.com base URL. JSON output
 *     relies on the system prompt instruction; Zod validation catches any
 *     non-conforming response, failing cleanly rather than corrupting anything.
 *   - Any other endpoint that answers 400 about response_format gets the same
 *     request once more without it.
 *   - Ollama: model-dependent. Larger models typically comply; smaller ones
 *     may not. Same Zod safety net applies.
 *
 * Anthropic compatibility layer positioning:
 *   Anthropic states their OpenAI-compatible layer is "primarily intended to
 *   test and compare model capabilities, and is not considered a long-term or
 *   production-ready solution." Self-hosters choosing Claude should be aware.
 *   The layer is functional and the compile flow works through it, but it is
 *   not Anthropic's recommended production path.
 *
 * Uses Node's native fetch (available since Node 18 LTS). No external HTTP library.
 *
 * Retry policy: exponential backoff on 429 (rate limit) and 5xx (server errors).
 * Non-retryable errors (400, 401, 403, 404) throw immediately.
 */
import type {
  LlmProvider,
  LlmProviderConfig,
  CompletionOptions,
  CompletionResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class LlmProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: LlmProviderConfig) {
    this.apiKey = config.apiKey;
    // Ensure baseUrl does not have a trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.model = config.model;
  }

  async complete(opts: CompletionOptions): Promise<CompletionResult> {
    const url = `${this.baseUrl}/chat/completions`;

    let sendResponseFormat = opts.response_format !== undefined && !rejectsJsonObject(this.baseUrl);
    const bodyFor = (withFormat: boolean) => ({
      model: this.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0,
      ...(opts.max_tokens !== undefined && { max_tokens: opts.max_tokens }),
      ...(withFormat && { response_format: opts.response_format }),
    });

    let lastError: LlmProviderError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
          },
          body: JSON.stringify(bodyFor(sendResponseFormat)),
        });

        if (!response.ok) {
          const statusCode = response.status;
          const responseBody = await response.text().catch(() => "");
          const retryable = statusCode === 429 || statusCode >= 500;

          // An endpoint that refuses JSON mode: ask again without it, once.
          if (statusCode === 400 && sendResponseFormat && /response_format/.test(responseBody)) {
            sendResponseFormat = false;
            attempt--;
            continue;
          }

          lastError = new LlmProviderError(
            `LLM provider returned ${statusCode}: ${responseBody.slice(0, 500)}`,
            statusCode,
            retryable,
          );

          if (!retryable) {
            throw lastError;
          }
          continue;
        }

        const json = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        };

        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new LlmProviderError(
            "LLM provider response missing choices[0].message.content",
            null,
            false,
          );
        }

        return {
          content,
          usage: json.usage,
        };
      } catch (err) {
        if (err instanceof LlmProviderError) {
          if (!err.retryable) throw err;
          lastError = err;
          continue;
        }
        // Network error (ECONNREFUSED, timeout, etc.) - retryable
        lastError = new LlmProviderError(
          `LLM provider network error: ${err instanceof Error ? err.message : String(err)}`,
          null,
          true,
        );
      }
    }

    // All retries exhausted
    throw lastError ?? new LlmProviderError("LLM provider failed after retries", null, true);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Anthropic's OpenAI-compatible layer accepts only json_schema, not json_object. */
function rejectsJsonObject(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
