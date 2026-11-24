/**
 * Database and job-queue handles shared by the HTTP layer.
 *
 * The Drizzle instance is created by apps/server and passed to buildApp;
 * routes read it from the request context (c.var.db).
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type Db = NodePgDatabase<Record<string, never>>;

/** Enqueue function type - matches the subset of PgBoss.send() we need. */
export type EnqueueFn = (queue: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<string | null>;
