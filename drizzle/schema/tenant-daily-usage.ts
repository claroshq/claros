import { pgTable, uuid, text, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

/**
 * Per product and UTC day (P5b): LLM tokens used (settings.llm_daily_token_budget)
 * and when the daily waiting-approvals mail went out (settings.approvals.daily_digest).
 * day is the UTC date "YYYY-MM-DD" for tokens; digest rows use the product's local date.
 */
export const tenantDailyUsage = pgTable(
  "tenant_daily_usage",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    day: text("day").notNull(),
    llmTokens: integer("llm_tokens").notNull().default(0),
    digestSentAt: timestamp("digest_sent_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ name: "tenant_daily_usage_pkey", columns: [table.tenantId, table.day] })],
);
