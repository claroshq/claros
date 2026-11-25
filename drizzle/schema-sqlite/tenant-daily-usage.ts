import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

/** Per product and day (P5b). See ../schema/tenant-daily-usage.ts. */
export const tenantDailyUsage = sqliteTable(
  "tenant_daily_usage",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    day: text("day").notNull(),
    llmTokens: integer("llm_tokens").notNull().default(0),
    digestSentAt: integer("digest_sent_at", { mode: "timestamp_ms" }),
  },
  (table) => [primaryKey({ name: "tenant_daily_usage_pkey", columns: [table.tenantId, table.day] })],
);
