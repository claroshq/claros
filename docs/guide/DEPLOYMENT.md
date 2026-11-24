# Deployment: Running Beyond One Machine

This document covers what changes when you move from the single-machine compose stack to a production deployment. [INSTALLATION.md](./INSTALLATION.md) remains the complete single-machine reference.

---

## External Postgres

The compose stack bundles Postgres 16 with pgvector. For production, use an external managed Postgres (AWS RDS, Google Cloud SQL, Neon, Supabase, or your own).

Requirements:
- Postgres 16+ (15 may work but is untested)
- The `vector` extension available (`CREATE EXTENSION IF NOT EXISTS vector` runs in migrations)
- A **direct connection** (not a connection pooler). pg-boss needs session persistence for `LISTEN/NOTIFY` and advisory locks. The server refuses URLs containing `-pooler` or `?pgbouncer=true` at startup

To use external Postgres:
1. Run `docker compose run --rm install` and answer "external" when asked (or pass `--database-url <url>` to skip the prompt)
2. The install command writes your URL to `.env`, tests the connection, and applies migrations
3. Start with `docker compose up`. The claim URL is printed directly to the console. The compose file passes `DATABASE_URL` from `.env` to the app container

You may remove the `postgres` service from docker-compose.yml entirely once external Postgres is confirmed working.

### Why not SQLite?

Claros requires Postgres specifically. SQLite cannot substitute. The reasons:

- **pgvector**: knowledge base embeddings use `vector(1536)` columns with cosine-distance indexes
- **Table partitioning**: the `events` table is range-partitioned by `received_at` (monthly)
- **pg-boss**: the job queue uses Postgres schemas, `LISTEN/NOTIFY`, and advisory locks
- **Advisory locks**: ingest deduplication uses transaction-scoped advisory locks for serialization

---

## Multiple instances

The single Docker image accepts a `--role` flag:

```
--role=all        Everything (default, the compose stack)
--role=api        HTTP API + dashboard serving only
--role=worker     Background job handlers only
--role=scheduler  Cron job scheduling only
```

Split rules:
- **Exactly one scheduler.** It registers cron jobs in pg-boss. Duplicates double-schedule every periodic task.
- **Any number of API replicas.** Stateless except for the claim token (first boot only). Put a load balancer in front.
- **Any number of worker replicas.** pg-boss distributes jobs; multiple workers process them concurrently. Each claims work via `FOR UPDATE SKIP LOCKED`.
- **Bootstrap seed runs only on `api` and `all` roles.** Workers and schedulers never touch tenants or users.

---

## Secrets that must be identical across instances

When running multiple containers (API replicas, separate worker), these values MUST be the same in every instance. If they disagree, failures are silent and intermittent.

| Secret | What breaks when instances disagree |
|---|---|
| `DATABASE_URL` | Obviously - different databases mean split-brain state |
| `ENCRYPTION_KEY` | Instance A encrypts transport credentials; instance B cannot decrypt them. Transport resolution fails silently (null adapter, messages stay `approved`). Symptom: "emails not sending" that comes and goes depending on which instance handles the request |
| `UNSUBSCRIBE_SIGNING_KEY` | Instance A signs unsubscribe tokens; instance B cannot validate them. Unsubscribe clicks fail with 400. Symptom: "unsubscribe broken" reports from recipients, compliance risk |
| `BASE_URL` | Different base URLs mean different unsubscribe links baked into email headers. Once delivered, these links are permanent. Symptom: some emails have working unsubscribe links, others do not |

The `claros install` command generates secrets once and writes them to `.env`. When deploying to multiple instances, copy the same `.env` values (or inject them from your secret manager) to every container.

### What happens if you lose the keys

- **Lost `ENCRYPTION_KEY`**: all stored transport and LLM credentials become undecryptable. Re-enter them via `claros transport set` / `claros llm set`. No data loss, but operational downtime.
- **Lost `UNSUBSCRIBE_SIGNING_KEY`**: all one-click unsubscribe links in already-delivered email stop working. This is a compliance failure. You must generate a new key and accept that old links are broken. New email will use the new key.

Both keys should be backed up in a secrets manager alongside your database credentials.

---

## The claim token and multi-instance boot

The claim token (the first-login URL) is stored in memory, not in the database. If you run multiple API instances, each generates its own claim token at boot. Only one needs to be used - the first claim creates the owner user, and all other instances' claim URLs become invalid (they check the users table before accepting).

For automated provisioning (CI, infrastructure-as-code), use `SEED_ADMIN_EMAIL` instead. It creates the owner at boot without a browser claim. Then use `claros login-link <email>` to obtain a login URL.

---

## Health checks

`GET /health` returns `{"status":"ok","role":"...","edition":"..."}` for all roles. Use it as your load balancer health check and container orchestrator liveness probe.

`GET /version` returns `{"commit":"...","edition":"...","builtAt":"..."}` for deployment verification.

---

## The claim token and multi-instance boot

The claim token (the first-login URL) lives in process memory, not the database. It is generated once per boot when zero users exist.

**Limitation:** if you start multiple API replicas before claiming, each generates its own token. A claim URL from instance A fails if the load balancer routes the request to instance B. The 403 page explains this clearly.

**Recommended sequence:**
1. Run `claros install` (one-off, before any instances are running)
2. Start a SINGLE API instance
3. Claim the account via the logged URL
4. Then scale to multiple replicas

After the first owner exists, the claim surface is gone permanently and this limitation is irrelevant. For automated/headless provisioning, use `SEED_ADMIN_EMAIL` instead (creates the owner at boot deterministically, no claim URL needed, works with any number of replicas).

---

## Upgrading in a multi-instance setup

1. Take a database backup (`pg_dump`)
2. Run migrations ONCE (either from a one-off container with `CLAROS_MIGRATE_ON_BOOT=true`, or from a source checkout with `npm run db:migrate`)
3. Roll new containers. Migrations are expand-contract: new code always works against the previous schema

Do not let every replica migrate simultaneously. Use a leader-election pattern or a dedicated migration job.
