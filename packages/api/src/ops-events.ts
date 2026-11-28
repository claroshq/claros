/**
 * Ops events recorded by the API (G25): Resend webhook failures and
 * ingestion items that were not stored.
 *
 * Every signature or processing failure for a product adds to a windowed
 * counter (instance setting webhook.window.<product>, one atomic statement,
 * constant space). When a 15-minute window reaches 10 failures an error
 * event is recorded (alert mail within one content tick); later failures in
 * that window only keep the alert fresh. Requests for products without a
 * webhook secret (unknown or unconfigured paths) are not counted, so the
 * unauthenticated endpoint cannot be used to fill the database.
 *
 * Recording never throws: a webhook response never depends on it.
 */
import { ALERT_RULES, COUNTER_PREFIX, OPS_KIND, opsFingerprint, windowStartMs } from "@claros/core";
import { storeFor } from "@claros/store";
import type { Db } from "./plugins/db.js";

export type WebhookFailureReason = "signature" | "payload" | "processing";

export async function recordWebhookFailure(
  db: Db,
  tenantId: string,
  reason: WebhookFailureReason,
  now: Date = new Date(),
): Promise<void> {
  try {
    const store = storeFor(db).ops;
    const total = await store.bumpCounter({
      key: `${COUNTER_PREFIX.WEBHOOK}${tenantId}`,
      windowStart: windowStartMs(now, ALERT_RULES.webhookWindowMinutes),
      count: 1,
      errors: 1,
      now,
    });
    const threshold = ALERT_RULES.webhookFailureThreshold;
    if (total.errors < threshold) return;
    const message =
      `Resend webhooks are failing: ${threshold} or more signature or processing failures ` +
      `in ${ALERT_RULES.webhookWindowMinutes} minutes. Check the webhook signing secret in Settings, Transports.`;
    const fingerprint = opsFingerprint(OPS_KIND.WEBHOOK_FAILURES, tenantId, message);
    if (total.errors > threshold && (await store.touchAlert({ fingerprint, at: now }))) return;
    await store.recordEvent(
      {
        at: now,
        tenantId,
        kind: OPS_KIND.WEBHOOK_FAILURES,
        severity: "error",
        fingerprint,
        message,
        context: { failures: total.errors, last_reason: reason },
      },
      { alert: true },
    );
  } catch (err) {
    console.error("[alerts] could not record a webhook failure:", err instanceof Error ? err.message : err);
  }
}

/**
 * An ingestion item that was not stored: invalid (reported in the batch's
 * errors[], not retried) or a storage failure (the batch answered 503 and
 * should be sent again). Every one is an ops event, so a dropped event is
 * visible on Health and alerts by mail; the alert groups by product and
 * reason. Never throws.
 */
export async function recordIngestFailure(
  db: Db,
  tenantId: string,
  reason: "invalid" | "processing",
  context: Record<string, unknown>,
  now: Date = new Date(),
): Promise<void> {
  try {
    const message =
      reason === "processing"
        ? "Events could not be stored: a batch item failed and the batch was answered with 503 so the sender retries it. If this repeats, the sender may be dropping events."
        : "Events were rejected as invalid and not stored. The sender should fix them; resending the same item will not help.";
    await storeFor(db).ops.recordEvent(
      {
        at: now,
        tenantId,
        kind: OPS_KIND.INGEST_FAILED,
        severity: reason === "processing" ? "error" : "warning",
        fingerprint: opsFingerprint(OPS_KIND.INGEST_FAILED, tenantId, message),
        message,
        context,
      },
      { alert: true },
    );
  } catch (err) {
    console.error("[alerts] could not record an ingestion failure:", err instanceof Error ? err.message : err);
  }
}
