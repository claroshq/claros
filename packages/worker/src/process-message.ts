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
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ProcessMessageJobData } from "@claros/core";
import { processOneContentMessage, type ContentCandidate } from "./content.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface ProcessMessageResult {
  /** Whether the message was claimed (was still at pending_generation). */
  claimed: boolean;
  /** Outcome from content processing, if claimed. */
  outcome?: "advanced" | "skipped" | "value_gated" | "failed" | "error";
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
  const claimed = await db.execute<{
    id: string;
    tenant_id: string;
    contact_id: string;
    flow_id: string;
    membership_id: string;
    flow_step_order: number | null;
    brain_action_type: string | null;
  }>(sql`
    UPDATE lifecycle_messages
    SET status = 'generating', updated_at = ${now}
    WHERE id = ${messageId}
      AND tenant_id = ${tenantId}
      AND status = 'pending_generation'
    RETURNING id, tenant_id, contact_id, flow_id, membership_id,
              flow_step_order, brain_action_type
  `);

  if (claimed.rows.length === 0) {
    // Already claimed by cron tick or another job - no-op
    return { claimed: false };
  }

  const row = claimed.rows[0]!;
  const candidate: ContentCandidate = {
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    flowId: row.flow_id,
    membershipId: row.membership_id,
    flowStepOrder: row.flow_step_order,
    brainActionType: row.brain_action_type,
  };

  const outcome = await processOneContentMessage(db, candidate, now);
  return { claimed: true, outcome };
}
