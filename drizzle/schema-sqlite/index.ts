/**
 * SQLite / Cloudflare D1 twin of ../schema (Postgres).
 *
 * Same tables, columns and indexes, with SQLite types:
 *   - uuid -> text, generated in code (crypto.randomUUID)
 *   - timestamptz -> integer milliseconds (Drizzle "timestamp_ms": Date in, Date out)
 *   - jsonb, text[] -> text holding JSON (Drizzle "json" mode)
 *   - boolean -> integer 0/1 (Drizzle "boolean" mode)
 *   - date -> text YYYY-MM-DD
 *   - pgvector embedding -> JSON text; no vector index (FTS5 instead)
 *   - events is a plain table (no partitions)
 * Keep it in step with ../schema: every schema change touches both.
 */
export { tenants } from "./tenants.js";
export { users } from "./users.js";
export { sessions } from "./sessions.js";
export { magicLinkTokens } from "./magic-link-tokens.js";
export { invites } from "./invites.js";
export { apiKeys } from "./api-keys.js";
export { contacts } from "./contacts.js";
export { events } from "./events.js";
export { flows } from "./flows.js";
export { flowMemberships } from "./flow-memberships.js";
export { lifecycleMessages } from "./lifecycle-messages.js";
export { kbEntries } from "./kb-entries.js";
export { templates } from "./templates.js";
export { lifecycleTransitions } from "./lifecycle-transitions.js";
export { transportConfigs } from "./transport-configs.js";
export { suppressions } from "./suppressions.js";
export { contactConflicts } from "./contact-conflicts.js";
export { llmConfigs } from "./llm-configs.js";
export { scanCheckpoints } from "./scan-checkpoints.js";
export { messageEvents } from "./message-events.js";
export { retentionGridSnapshots } from "./retention-grid-snapshots.js";
export { memberships } from "./memberships.js";
export { instanceSettings } from "./instance-settings.js";
export { claimTokens } from "./claim-tokens.js";
export { topics } from "./topics.js";
export { contactTopics } from "./contact-topics.js";
export { opsEvents, opsAlerts } from "./ops.js";
