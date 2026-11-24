/**
 * Database plugin - decorates the Fastify instance with a Drizzle DB client.
 *
 * The Drizzle instance is created externally (by apps/server) and passed
 * to buildApp as an option. This plugin simply decorates it so routes
 * and hooks can access it via `app.db`.
 */
import type { FastifyInstance } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type Db = NodePgDatabase<Record<string, never>>;

/** Enqueue function type - matches the subset of PgBoss.send() we need. */
export type EnqueueFn = (queue: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<string | null>;

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    enqueue?: EnqueueFn;
  }
}

/**
 * Decorate the Fastify instance with the drizzle DB client.
 * Must be called on the root instance before route registration.
 */
export function registerDbPlugin(app: FastifyInstance, db: Db): void {
  app.decorate("db", db);
}
