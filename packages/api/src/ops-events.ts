/**
 * Ops events recorded by the API (G25): Resend webhook failures.
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
