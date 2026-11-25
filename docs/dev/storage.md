# Storage layer

Claros runs on Postgres (Node, Docker) and, from v0.8, on SQLite / Cloudflare D1 (Workers). All database access goes through `@claros/store` so that engine and API code never contain SQL for a specific database.

## Shape

```
packages/store/src/
  types.ts           Store: one Queries interface per calling module
  areas/<area>.ts    the Queries interface for one module (e.g. workerDrain)
  pg/<area>.ts       Postgres implementation (Drizzle pg-core + raw SQL)
  d1/<area>.ts       SQLite / D1 implementation (from v0.8)
  index.ts           storeFor(db), registerStore(db, store)
```

Areas are named after the module that runs the queries (`apiFlows` for `packages/api/src/routes/flows.ts`, `workerDrain` for `packages/worker/src/drain.ts`). One owner per area keeps changes local; the same query needed by two modules may exist in both areas.

## Call sites

Modules keep receiving the database handle they always received and resolve the Store from it:

```ts
import { storeFor } from "@claros/store";

const candidates = await storeFor(db).workerDrain.claimBatch({ limit, now });
```

`storeFor` returns the Store registered for that handle (`registerStore` at startup); an unregistered handle is treated as Postgres.

## Rules for a query method

- One method is one database operation, or one atomic unit (a Postgres transaction, a D1 `batch()`). Never split an atomic unit across methods, and never hold a transaction open across a call to something outside the Store.
- Arguments and results are plain values: strings, numbers, booleans, `Date` for timestamps, plain objects and arrays. No Drizzle types, no `sql` fragments.
- Tenant scope is explicit: every method on tenant data takes `tenantId` and filters by it.
- Concurrency invariants live in the database: unique and partial indexes, and compare-and-swap updates (`UPDATE ... WHERE status = ? RETURNING`). A method that claims rows returns exactly the rows it claimed.
- Name methods by intent (`claimDueMessages`, `markSent`), not by SQL.
- Postgres-only features stay inside `pg/`: `FOR UPDATE SKIP LOCKED`, advisory locks, `FILTER (WHERE)`, `date_trunc`, `jsonb` operators, pgvector `<=>`, partitions. The D1 implementation reaches the same result with SQLite features (documented per method).

## Tests

- Behaviour is tested through the calling modules (the existing `*.db.test.ts` suites on Postgres).
- Store contract tests live in `packages/store/tests` and run the same assertions on every backend (`tests/support/backends.ts`): the local Postgres (when `DATABASE_URL` is set) and an in-memory D1 database from Miniflare, the engine `wrangler dev` uses. A D1 query module is done when its contract tests pass on both.
- Until a D1 module is written, its methods throw "not implemented for D1 yet" (`src/d1/db.ts`).

## Schemas and migrations

- Postgres: `drizzle/schema` and `drizzle/migrations` (`npm run db:generate`).
- SQLite / D1: `drizzle/schema-sqlite` and `drizzle/migrations-sqlite` (`npm run db:generate:sqlite`). Same tables, columns and index names; `packages/store/tests/schema-parity.test.ts` fails when the two drift.
- SQLite type mapping: uuid -> text (generated in code), timestamptz -> integer milliseconds (Drizzle `timestamp_ms`, so values are `Date` on both sides), jsonb and text[] -> JSON text, boolean -> integer 0/1, date -> `YYYY-MM-DD` text. The knowledge base gets an FTS5 table (`kb_fts`) kept in sync by triggers instead of a pgvector index; `events` is a plain table instead of monthly partitions.

## Known differences on D1

Each is covered by a contract test or documented in the module header:

- Case-insensitive matching (`ILIKE`, `lower()`) folds ASCII letters only on SQLite; Postgres folds all of Unicode.
- Timestamps that the Postgres code reads through raw SQL come back as Postgres text (`2026-05-09 00:12:08.198+00`); on D1 they are `Date` values and serialise as ISO-8601. Callers accept both.
- There are no interactive transactions on D1. Multi-statement units are one `batch()` (atomic), and read-then-write guarantees are single guarded statements. Where Postgres decides inside a lock (enrollment, ingest lifecycle transition), D1 decides from a prior read and the guarded write refuses a stale decision: invariants (one event per messageId, one active nurture membership per contact, one transition per state change) always hold, but a request that loses a race may be refused where Postgres would have waited.
- "Now" is the Worker clock, not the database clock.
- Drizzle 0.45 cannot put raw `sql` statements inside `db.batch()` on D1; use builder queries (with `sql` fragments) or the module's raw batch helper.
