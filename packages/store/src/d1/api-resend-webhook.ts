/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-resend-webhook.ts.
 */
import type { D1Db } from "./db.js";
import { notYetOnD1 } from "./db.js";
import type { ApiResendWebhookQueries } from "../areas/api-resend-webhook.js";

export function d1ApiResendWebhook(db: D1Db): ApiResendWebhookQueries {
  void db;
  return notYetOnD1<ApiResendWebhookQueries>("apiResendWebhook");
}
