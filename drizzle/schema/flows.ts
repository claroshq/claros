import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";
import { topics } from "./topics.js";

export const flows = pgTable("flows", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  name: text("name").notNull(),
  description: text("description"),
  priority: integer("priority").default(0), // higher wins
  triggerType: text("trigger_type").notNull(), // lifecycle_transition|event|segment|manual
  triggerConfig: jsonb("trigger_config").notNull(),
  steps: jsonb("steps").notNull(), // FlowStep[]
  source: text("source").default("manual"), // manual|library|brain_suggested
  contentMode: text("content_mode").default("ai_drafted"), // ai_drafted|fixed_content
  status: text("status").default("draft"), // draft|active|paused|archived
  approvalMode: text("approval_mode").default("require"), // require|auto
  flowClass: text("flow_class").default("nurture").notNull(), // [v2] critical|nurture
  reentryPolicy: text("reentry_policy").default("cooldown").notNull(), // [v2] once|cooldown|every_time
  reentryCooldownDays: integer("reentry_cooldown_days").default(30), // [v2]
  promptSource: text("prompt_source"), // original natural language prompt
  compiledPlan: jsonb("compiled_plan"), // deterministic execution plan
  compiledAt: timestamp("compiled_at", { withTimezone: true }),
  // [impl] task 11: compilation status tracking
  compileStatus: text("compile_status"), // null|pending|ready|failed
  compileError: text("compile_error"), // human-readable error when status = failed
  /** Topic of the flow's messages (G8a); null = no topic, behaves as before topics. */
  topicId: uuid("topic_id").references(() => topics.id),
  /** Stable identifier for config as code (G2); null for flows created in the dashboard. */
  slug: text("slug"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("uq_flows_tenant_slug").on(table.tenantId, table.slug).where(sql`slug IS NOT NULL`),
]);
