/**
 * KB embedding worker - generates pgvector embeddings for kb_entries rows.
 *
 * Triggered by: POST /v1/kb (on create) and PATCH /v1/kb/:id (when content
 * changes). The route enqueues a KbEmbedJobData job with singletonKey =
 * kb_entry_id so only one embedding job runs per entry at a time.
 *
 * Embedding model:
 *   Resolved from the tenant's active llm_configs row via resolveEmbeddingProvider().
 *   The decrypted config shape is { apiKey, baseUrl, model, embedding_model? }.
 *   embedding_model defaults to "text-embedding-3-small" when absent.
 *   The baseUrl and apiKey carry over from the chat config; the embedding call
 *   hits <baseUrl>/embeddings (OpenAI-compatible endpoint).
 *
 * Content truncation:
 *   OpenAI embedding models accept up to 8191 tokens (~32K chars). Long
 *   documents are truncated at EMBEDDING_MAX_CHARS (approx 30,000 chars,
 *   derived from 8000 tokens * 4 chars/token with a safety margin). When
 *   truncation occurs a warning is logged naming the entry.
 *   Consequence: a truncated entry is only semantically searchable by its head.
 *   See docs/BACKLOG.md "KB chunking" for the full-document solution.
 *
 * Failure classes:
 *   Two distinct failure classes require different handling:
 *
 *   Transient failures (network errors, timeouts, 429, 5xx) - should retry:
 *     callEmbedding throws a plain Error. The handler re-throws so pg-boss
 *     marks the job failed and retries per retryLimit/retryDelay.
 *     The entry stays at embedding_status = 'pending'.
 *
 *   Permanent failures - must NOT retry, recorded in kb_entries:
 *     - Configuration errors (missing LLM config, decrypt failure, missing
 *       ENCRYPTION_KEY): detected before the embedding call.
 *     - API client errors 4xx (bad key, wrong model): callEmbedding throws
 *       EmbeddingPermanentError. The handler catches and records. No retry.
 *       The entry is re-embeddable: fix the config, PATCH any field to
 *       re-enqueue with a fresh job.
 *     - Dimensionality mismatch: vector length != 1536.
 *
 *     All permanent failures: handler calls markPermanentFailure() then returns
 *     normally. pg-boss marks the job complete, no retry.
 *     Mirrors the flows.compile_status / compile_error pattern.
 *
 * Embedding status (gap 2):
 *   kb_entries.embedding_status: null|'pending'|'failed'.
 *   Non-NULL embedding = success (status cleared to null; vector is the evidence).
 */
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { kbEntries } from "@claros/db/schema";
import type { KbEmbedJobData } from "@claros/core";
import {
  resolveEmbeddingProvider,
  callEmbedding,
  EmbeddingPermanentError,
  DEFAULT_EMBEDDING_MODEL,
} from "./embedding-client.js";

export { EmbeddingPermanentError, DEFAULT_EMBEDDING_MODEL };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

/** Expected dimensionality of kb_entries.embedding (vector(1536)). */
const EXPECTED_DIMENSIONS = 1536;

/**
 * Maximum character count before truncating content for embedding.
 *
 * Derived from 8000 tokens (conservative, below the 8191 OpenAI limit) *
 * 4 chars/token approximation (same as MAX_CONTEXT_TOKENS in context-budget.ts).
 */
export const EMBEDDING_MAX_CHARS = 32_000;

// ---------------------------------------------------------------------------
// handleKbEmbedJob
// ---------------------------------------------------------------------------

/**
 * Process a single KB embedding job.
 *
 * Permanent failures are written to kb_entries (embedding_status = 'failed')
 * and the handler returns normally - pg-boss marks the job complete, no retry.
 *
 * Transient failures (network, 429, 5xx) are re-thrown - pg-boss retries.
 */
export async function handleKbEmbedJob(
  data: KbEmbedJobData,
  db: Db,
): Promise<void> {
  const { kb_entry_id, tenant_id } = data;

  // 1. Read the kb_entries row
  const rows = await db
    .select()
    .from(kbEntries)
    .where(and(eq(kbEntries.id, kb_entry_id), eq(kbEntries.tenantId, tenant_id)))
    .limit(1);

  if (rows.length === 0) {
    // Entry deleted between enqueue and processing - not an error, just skip.
    console.warn(
      `[kb-embed] entry ${kb_entry_id} not found for tenant ${tenant_id}, skipping`,
    );
    return;
  }

  const entry = rows[0]!;

  // 2. Resolve the tenant's embedding provider config.
  //    Permanent failures (missing config, decrypt error) return ok=false with permanent=true.
  const providerResult = await resolveEmbeddingProvider(db, tenant_id);
  if (!providerResult.ok) {
    if (providerResult.permanent) {
      await markPermanentFailure(db, kb_entry_id, tenant_id, providerResult.reason);
      console.error(`[kb-embed] permanent failure for entry ${kb_entry_id}: ${providerResult.reason}`);
      return; // No throw - pg-boss marks the job complete.
    }
    // Non-permanent resolver failure (should not occur currently but defensive).
    throw new Error(`[kb-embed] provider resolution failed: ${providerResult.reason}`);
  }

  const { apiKey, baseUrl, embeddingModel } = providerResult;

  // 3. Truncate content if necessary
  let content = entry.content;
  if (content.length > EMBEDDING_MAX_CHARS) {
    console.warn(
      `[kb-embed] entry "${entry.title}" (${kb_entry_id}) content is ` +
        `${content.length} chars, exceeding the ${EMBEDDING_MAX_CHARS}-char ` +
        `embedding limit. Truncating to head. Full semantic coverage requires ` +
        `chunking (see docs/BACKLOG.md "KB chunking").`,
    );
    content = content.slice(0, EMBEDDING_MAX_CHARS);
  }

  // 4. Call the embedding endpoint.
  //    EmbeddingPermanentError (4xx) = record and return without retry.
  //    All other throws (network, 429, 5xx) = re-throw for pg-boss retry.
  let embedding: number[];
  try {
    embedding = await callEmbedding(baseUrl, apiKey, embeddingModel, content);
  } catch (err) {
    if (err instanceof EmbeddingPermanentError) {
      await markPermanentFailure(db, kb_entry_id, tenant_id, err.message);
      console.error(`[kb-embed] permanent failure for entry ${kb_entry_id}: ${err.message}`);
      return;
    }
    throw err; // Transient - re-throw for pg-boss retry.
  }

  // 5. Validate dimensionality.
  if (embedding.length !== EXPECTED_DIMENSIONS) {
    const reason =
      `Embedding model "${embeddingModel}" returned a vector of ` +
      `${embedding.length} dimensions, but kb_entries.embedding is vector(${EXPECTED_DIMENSIONS}). ` +
      `Change the embedding_model in your LLM configuration to a model that ` +
      `produces ${EXPECTED_DIMENSIONS}-dimensional vectors (e.g., ` +
      `"text-embedding-3-small" or "text-embedding-ada-002").`;
    await markPermanentFailure(db, kb_entry_id, tenant_id, reason);
    console.error(`[kb-embed] permanent failure for entry ${kb_entry_id}: ${reason}`);
    return;
  }

  // 6. Write the embedding back, clearing embedding_status (vector = success).
  await db
    .update(kbEntries)
    .set({
      embedding: embedding,
      embeddingStatus: null,
      embeddingError: null,
      updatedAt: new Date(),
    } as any)
    .where(and(eq(kbEntries.id, kb_entry_id), eq(kbEntries.tenantId, tenant_id)));
}

// ---------------------------------------------------------------------------
// Permanent failure recording
// ---------------------------------------------------------------------------

/**
 * Record a permanent failure on the kb_entries row.
 * Sets embedding_status = 'failed' and embedding_error = reason.
 * Does NOT throw. Caller returns after this so pg-boss marks the job complete.
 */
async function markPermanentFailure(
  db: Db,
  kbEntryId: string,
  tenantId: string,
  reason: string,
): Promise<void> {
  await db
    .update(kbEntries)
    .set({
      embeddingStatus: "failed",
      embeddingError: reason.slice(0, 2000),
      updatedAt: new Date(),
    } as any)
    .where(and(eq(kbEntries.id, kbEntryId), eq(kbEntries.tenantId, tenantId)));
}
