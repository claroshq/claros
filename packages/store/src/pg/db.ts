import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/** Drizzle handle on Postgres (node-postgres driver). */
export type PgDb = NodePgDatabase<Record<string, never>>;
