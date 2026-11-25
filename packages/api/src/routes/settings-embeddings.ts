/**
 * Embedding provider settings: GET, PUT, DELETE /v1/settings/embeddings.
 *
 * Embeddings power semantic search over the knowledge base (kb_context).
 * They are optional and have their own provider, separate from the chat LLM,
 * because Anthropic has no embeddings API. Without a provider, kb_context
 * uses word matching; pinned entries, kb_select and kb_ref need no vectors.
 *
 *   GET    /v1/settings/embeddings  (member)
 *     The effective embedding provider: { embeddings: {...} | null }.
 *     source "embedding_config" = saved here; "llm_config" = the chat LLM
 *     config serves embeddings (installs that predate this setting, any
 *     provider but Anthropic and Ollama, or an explicit embedding_model).
 *     Never returns the api_key.
 *
 *   PUT    /v1/settings/embeddings  (owner)
 *     Body: { provider: "openai" | "custom", api_key?, base_url?, model? }
 *     Verifies the endpoint (one embedding call, 1536 dimensions required)
 *     before storing anything; 422 with the provider's answer otherwise.
 *     When the effective base URL, model or dimensions change, every stored
 *     vector of the product is dropped (vectors from different models are
 *     incomparable). Then the first re-embed batch is enqueued.
 *
 *   DELETE /v1/settings/embeddings  (owner)
 *     Removes the saved provider. The effective provider falls back to the
 *     chat LLM config when that serves embeddings, otherwise to none (word
 *     matching). Vectors are dropped when the effective provider changes.
 *
 * Re-embed responses carry { reembed: { enqueued, remaining, ... } | null };
 * null when the job queue is not available.
 */
import { z } from "zod";
import { storeFor } from "@claros/store";
import { encrypt, decrypt, parseEncryptionKey } from "@claros/adapters";
import {
  EMBEDDING_DIMENSIONS,
  KNOWN_EMBEDDING_PROVIDERS,
  LLM_PROVIDERS_WITHOUT_EMBEDDINGS,
  isKnownEmbeddingProvider,
  type EmbeddingConfigEnvelope,
} from "@claros/core";
import { resolveEmbeddingConfig, verifyEmbeddingEndpoint } from "../embedding-providers.js";
import type { Db, EnqueueFn } from "../plugins/db.js";
import { RoleRouter, validatedBody } from "../http/router.js";
import { validateBody, coerceString } from "../http/validate.js";
import { startReEmbed, type ReEmbedResult } from "./kb.js";

/** The default embedding model of the legacy llm_configs path. */
const LEGACY_DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

const embeddingBodySchema = z.object({
  provider: coerceString(),
  api_key: coerceString().optional(),
  base_url: coerceString().optional(),
  model: coerceString().optional(),
});

/** The effective embedding provider as the worker resolves it. */
export interface EffectiveEmbeddings {
  source: "embedding_config" | "llm_config";
  provider: string;
  base_url: string | null;
  model: string | null;
  /** Requests carry dimensions: 1536. */
  sends_dimensions: boolean;
  created_at: Date | null;
}

function decryptJson<T>(envelope: string): T | null {
  const env = process.env.ENCRYPTION_KEY;
  if (!env) return null;
  try {
    return JSON.parse(decrypt(envelope, parseEncryptionKey(env))) as T;
  } catch {
    return null;
  }
}

/**
 * Mirror of resolveEmbeddingProvider (packages/worker/src/embedding-client.ts)
 * for display and change detection. base_url and model are null when the
 * envelope cannot be decrypted.
 */
export async function loadEffectiveEmbeddings(db: Db, tenantId: string): Promise<EffectiveEmbeddings | null> {
  const store = storeFor(db).apiSettings;
  const own = await store.findActiveEmbeddingConfig(tenantId);
  if (own) {
    const c = decryptJson<EmbeddingConfigEnvelope>(own.config);
    return {
      source: "embedding_config",
      provider: own.provider,
      base_url: c?.baseUrl ?? null,
      model: c?.model ?? null,
      sends_dimensions: c?.sendDimensions ?? false,
      created_at: own.createdAt,
    };
  }
  const llm = await store.findActiveLlmConfig(tenantId);
  if (!llm) return null;
  const c = decryptJson<{ baseUrl?: string; embedding_model?: string }>(llm.config);
  if (!c?.embedding_model && LLM_PROVIDERS_WITHOUT_EMBEDDINGS.includes(llm.provider)) return null;
  return {
    source: "llm_config",
    provider: llm.provider,
    base_url: c?.baseUrl ?? null,
    model: c ? (c.embedding_model ?? LEGACY_DEFAULT_EMBEDDING_MODEL) : null,
    sends_dimensions: false,
    created_at: llm.createdAt,
  };
}

/** What makes stored vectors comparable: endpoint, model and dimensions. */
function vectorIdentity(e: EffectiveEmbeddings | null): string {
  if (!e) return "none";
  return JSON.stringify([(e.base_url ?? "").replace(/\/+$/, ""), e.model, e.sends_dimensions]);
}

/**
 * After the effective provider may have changed: drop incomparable vectors
 * (entries become 'skipped'), then start the first re-embed batch when a
 * provider resolves. Entries past the batch stay 'skipped' until Retry.
 */
async function afterProviderChange(
  db: Db,
  tenantId: string,
  before: EffectiveEmbeddings | null,
  after: EffectiveEmbeddings | null,
  enqueue: EnqueueFn | undefined,
): Promise<{ vectors_cleared: boolean; reembed: ReEmbedResult | null }> {
  const changed = vectorIdentity(before) !== vectorIdentity(after);
  if (changed) {
    await storeFor(db).apiKb.clearEmbeddings({ tenantId });
  }
  const reembed = after && enqueue ? await startReEmbed(db, tenantId, enqueue) : null;
  return { vectors_cleared: changed, reembed };
}

function serialize(e: EffectiveEmbeddings | null) {
  if (!e) return null;
  return {
    source: e.source,
    provider: e.provider,
    base_url: e.base_url,
    model: e.model,
    dimensions: EMBEDDING_DIMENSIONS,
    sends_dimensions: e.sends_dimensions,
    created_at: e.created_at,
  };
}

export function registerEmbeddingRoutes(r: RoleRouter): void {
  r.get("/embeddings", "member", async (c) => {
    const db: Db = c.var.db;
    return c.json({ embeddings: serialize(await loadEffectiveEmbeddings(db, c.var.tenant!.id)) });
  });

  r.put("/embeddings", "owner", validatedBody(embeddingBodySchema), async (c) => {
    const v = validateBody(c, embeddingBodySchema);
    if (!v.ok) return v.response;
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const { provider, api_key, base_url, model } = v.value;

    if (!isKnownEmbeddingProvider(provider)) {
      return c.json({
        error:
          `Unknown embedding provider: "${provider}". Valid values: ${KNOWN_EMBEDDING_PROVIDERS.join(", ")}. ` +
          "Anthropic has no embeddings API; use OpenAI or an OpenAI-compatible endpoint.",
      }, 400);
    }

    const resolved = resolveEmbeddingConfig(provider, { apiKey: api_key, baseUrl: base_url, model });
    if (!resolved.ok) return c.json({ error: resolved.error }, 400);
    const effective = resolved.config;

    const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
    if (!encryptionKeyEnv) {
      return c.json({ error: "ENCRYPTION_KEY is not configured. Set ENCRYPTION_KEY before storing embedding credentials." }, 503);
    }
    let key: Buffer;
    try {
      key = parseEncryptionKey(encryptionKeyEnv);
    } catch (err) {
      return c.json({ error: `ENCRYPTION_KEY is invalid: ${err instanceof Error ? err.message : String(err)}` }, 503);
    }

    const verification = await verifyEmbeddingEndpoint(effective);
    if (!verification.ok) {
      const prefix =
        verification.kind === "http"
          ? `${effective.baseUrl} rejected the request (HTTP ${verification.status})`
          : verification.kind === "timeout"
            ? `${effective.baseUrl} did not answer within 10 seconds`
            : verification.kind === "unreachable"
              ? `${effective.baseUrl} could not be reached`
              : `${effective.baseUrl} answered, but not with a usable embedding`;
      const said = verification.detail !== "" ? `: ${verification.detail}` : "";
      return c.json({
        error: `${prefix}${said}. Nothing was stored.`,
        verification: { ok: false, kind: verification.kind, status: verification.status, detail: verification.detail },
      }, 422);
    }

    const envelope: EmbeddingConfigEnvelope = {
      apiKey: effective.apiKey,
      baseUrl: effective.baseUrl,
      model: effective.model,
      sendDimensions: verification.sendDimensions,
    };
    const before = await loadEffectiveEmbeddings(db, tenantId);
    const store = storeFor(db).apiSettings;
    await store.deactivateActiveEmbeddingConfigs(tenantId);
    await store.insertActiveEmbeddingConfig({
      tenantId,
      provider,
      encryptedConfig: encrypt(JSON.stringify(envelope), key),
    });
    const after = await loadEffectiveEmbeddings(db, tenantId);
    const change = await afterProviderChange(db, tenantId, before, after, c.var.enqueue);

    return c.json({ embeddings: serialize(after), verification: { ok: true }, ...change });
  });

  r.delete("/embeddings", "owner", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const before = await loadEffectiveEmbeddings(db, tenantId);
    await storeFor(db).apiSettings.deactivateActiveEmbeddingConfigs(tenantId);
    const after = await loadEffectiveEmbeddings(db, tenantId);
    const change = await afterProviderChange(db, tenantId, before, after, c.var.enqueue);
    return c.json({ embeddings: serialize(after), ...change });
  });
}
