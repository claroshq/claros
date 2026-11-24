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

Behaviour is tested through the calling modules (the existing `*.db.test.ts` suites). From v0.8 the same suites run against both Postgres and D1.
