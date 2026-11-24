/**
 * Postgres implementation of the queries used by packages/api/src/routes/webhooks/resend.ts.
 */
import type { PgDb } from "./db.js";
import type { ApiResendWebhookQueries } from "../areas/api-resend-webhook.js";

export function pgApiResendWebhook(db: PgDb): ApiResendWebhookQueries {
  void db;
  return {};
}
