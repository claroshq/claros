/**
 * LLM provider types - the contract for calling any OpenAI-compatible endpoint.
 *
 * One implementation (OpenAICompatibleProvider) covers OpenAI, Anthropic (via proxy),
 * Groq, Ollama, and any custom endpoint that implements the /v1/chat/completions shape.
 */

// ---------------------------------------------------------------------------
// Chat message format
// ---------------------------------------------------------------------------

/** A single message in the OpenAI-compatible chat format. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Completion request/response
// ---------------------------------------------------------------------------

/** Options for a chat completion request. */
export interface CompletionOptions {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" };
}

/** Parsed successful response from the provider. */
export interface CompletionResult {
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/** The provider interface - one implementation covers all OpenAI-compatible endpoints. */
export interface LlmProvider {
  complete(opts: CompletionOptions): Promise<CompletionResult>;
}

// ---------------------------------------------------------------------------
// Provider configuration (decrypted form)
// ---------------------------------------------------------------------------

/** The decrypted config shape stored in llm_configs.config after decryption. */
export interface LlmProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}
