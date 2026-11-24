import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.js";

/**
 * Scan phase checkpoint for forward-progress guarantees.
 *
 * Keyed by (scan_phase, tenant_id). Each phase updates the checkpoint after
 * each batch so that a crash resumes from where it left off rather than
 * re-processing the entire tenant from scratch.
 *
 * When a phase completes a full pass for a tenant, the row is deleted
 * (signaling "start fresh next run"). A stale checkpoint (started_at older
 * than 2x the scan interval) is discarded to handle crash recovery.
 *
 * discard_count tracks how many times a stale checkpoint was discarded -
 * a non-zero and growing count signals a phase that cannot finish.
 */
export const scanCheckpoints = sqliteTable(
  "scan_checkpoints",
  {
    scanPhase: text("scan_phase").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    lastId: text("last_id").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    discardCount: integer("discard_count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.scanPhase, table.tenantId] }),
  ]
);
