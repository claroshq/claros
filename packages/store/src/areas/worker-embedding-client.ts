/**
 * Queries used by packages/worker/src/embedding-client.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/worker-embedding-client.ts (Postgres) and, later,
 * ../d1/worker-embedding-client.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface WorkerEmbeddingClientQueries {}
