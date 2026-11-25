/**
 * Targeted content generation: process a single pending_generation message.
 *
 * Enqueued immediately after step advancement creates a pending_generation
 * message. Eliminates the 5-min content-generation cron wait.
 *
 * This handler claims and processes a single message by ID. If the message
 * is no longer at pending_generation (already claimed by the cron tick or
 * another targeted job), the job returns immediately with no effect.
 *
 * The processing logic is identical to processOneContentMessage in content.ts.
 * This file reuses that function directly after claiming the single message.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import type { ProcessMessageJobData } from "@claros/core";
import { processOneContentMessage, type ContentCandidate, type LlmCallStats } from "./content.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface ProcessMessageResult {
  /** Whether the message was claimed (was still at pending_generation). */
  claimed: boolean;
  /** Outcome from content processing, if claimed. */
  outcome?: "advanced" | "skipped" | "value_gated" | "failed" | "error" | "deferred";
  /** LLM calls made for the message, if claimed. */
  llm?: LlmCallStats;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a single claros.process-message job.
 *
 * Claims the specified message (CAS: pending_generation -> generating) and
 * processes it through the full Brain decide+draft+assess pipeline. If the
 * message is no longer at pending_generation, returns immediately.
 */
export async function handleProcessMessage(
  data: ProcessMessageJobData,
  db: Db,
): Promise<ProcessMessageResult> {
  const { tenant_id: tenantId, message_id: messageId } = data;
  const now = new Date();

  // Attempt to claim this single message (CAS: pending_generation -> generating)
  const row = await storeFor(db).workerProcessMessage.claimPendingGenerationMessage(tenantId, messageId, now);

  if (row === null) {
    // Already claimed by cron tick or another job - no-op
    return { claimed: false };
  }

  const candidate: ContentCandidate = {
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    flowId: row.flow_id,
    membershipId: row.membership_id,
    flowStepOrder: row.flow_step_order,
    brainActionType: row.brain_action_type,
    forcedActionType: row.forced_action_type ?? null,
  };

  const llm: LlmCallStats = { calls: 0, errors: 0 };
  const outcome = await processOneContentMessage(db, candidate, now, llm);
  return { claimed: true, outcome, llm };
}
