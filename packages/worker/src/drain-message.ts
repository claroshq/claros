/**
 * Targeted drain: send a single approved message.
 *
 * Enqueued immediately after a message reaches 'approved' status (auto-approve
 * in content generation, or manual approval via POST /v1/messages/:id/approve).
 * Eliminates the 15-min drain cron wait.
 *
 * This handler claims and sends a single message by ID. If the message is no
 * longer at 'approved' (already claimed by the cron drain or another targeted
 * job), the job returns immediately with no effect.
 *
 * The processing logic reuses processOneMessage from drain.ts.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { storeFor } from "@claros/store";
import type { DrainMessageJobData } from "@claros/core";
import { processOneMessage, routeMessage, type DrainCandidate, type MessageOutcome } from "./drain.js";
import type { TransportResolver } from "./transport.js";
import { resolveBaseUrl } from "./compliance.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

export interface DrainMessageResult {
  /** Whether the message was claimed (was still at 'approved'). */
  claimed: boolean;
  /** Outcome from drain processing, if claimed. */
  outcome?: MessageOutcome;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a single claros.drain-message job.
 *
 * Claims the specified message (CAS: approved -> sending) and processes it
 * through the full drain pipeline (transport resolution, throttle, compliance,
 * send). If the message is no longer at 'approved', returns immediately.
 *
 * @param data - Job payload with tenant_id and message_id.
 * @param db - Drizzle database instance.
 * @param resolveTransport - Resolves a TransportAdapter for a tenant.
 */
export async function handleDrainMessage(
  data: DrainMessageJobData,
  db: Db,
  resolveTransport: TransportResolver,
): Promise<DrainMessageResult> {
  const { tenant_id: tenantId, message_id: messageId } = data;
  const now = new Date();

  // Resolve transport first (no claim needed if transport is unavailable)
  const adapter = await resolveTransport(tenantId);
  if (adapter === null) {
    // No transport configured - message stays at 'approved' for cron drain
    return { claimed: false };
  }

  // Attempt to claim this single message (CAS: approved -> sending)
  // Also check scheduled_send_at constraint (must be null or <= now)
  const row = await storeFor(db).workerDrainMessage.claimApprovedMessage(tenantId, messageId, now);

  if (row === null) {
    // Already claimed by cron drain, not yet ready, or in a different status
    return { claimed: false };
  }

  const candidate: DrainCandidate = {
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    flowId: row.flow_id,
    flowStepOrder: row.flow_step_order,
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    retryCount: row.retry_count,
    topicId: row.topic_id ?? null,
  };

  // Transactional-topic messages take the transactional route (G26).
  const routed = await routeMessage(db, candidate, adapter, resolveTransport);
  if (routed.adapter === null) {
    // No usable transport on that route: back to 'approved' for the cron drain.
    await storeFor(db).workerDrain.releaseClaim(candidate.id, now);
    return { claimed: true };
  }

  const baseUrl = resolveBaseUrl();
  const outcome = await processOneMessage(db, candidate, now, routed.adapter, baseUrl, undefined, undefined, routed.topic);

  return { claimed: true, outcome };
}
