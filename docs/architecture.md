# Architecture

This page describes how Claros is built and what each install option offers. It is kept current with every release; [CHANGELOG.md](../CHANGELOG.md) records what changed.

> Status: since v0.8, Claros runs on **Postgres + Node (Docker)** or on **Cloudflare Workers + D1**. Both are supported install options; Postgres installs upgrade in place.

## Install options

| | Postgres + Node (Docker) | Cloudflare D1 + Workers |
|---|---|---|
| Available | Yes | Yes, since v0.8 |
| Install | `docker compose up`, see [Installation](guide/INSTALLATION.md) | `npx claros deploy`, see [Install on Cloudflare Workers + D1](install/cloudflare.md) |
| Dependencies | Postgres 16 with pgvector | a Cloudflare account |
| Job queue | pg-boss (inside Postgres) | Cloudflare Queues |
| Upgrades | pull the new tag, migrations run on boot or via `scripts/migrate.sh` | `npx claros upgrade` |

Both options run the same HTTP API and the same engine behaviour. Postgres stays fully supported.

## Components

| Package | Role |
|---|---|
| `packages/core` | Pure logic: flows, lifecycle state machine, enrollment, throttle gate, templates. No I/O |
| `packages/adapters` | Email transports (Resend, SMTP, Cloudflare Email Service), crypto, unsubscribe tokens |
| `packages/brain-oss` | Optional LLM module: compile, decide, draft, assess prompts for any OpenAI-compatible endpoint |
| `packages/api` | HTTP API on [Hono](https://hono.dev): ingest, management, dashboard auth, public pages, webhooks |
| `packages/worker` | Background jobs: scan, trigger checks, step advancement, content generation, drain, reaper |
| `packages/scheduler` | Recurring job schedule |
| `drizzle/` | Database schema and migrations |
| `apps/server` | Node entry point, operator CLI for Docker installs |
| `apps/worker` | Cloudflare Workers entry point (D1, Queues, cron, Static Assets) |
| `packages/store` | Every database query, with Postgres and SQLite / D1 implementations |
| `packages/cli` | `npx claros deploy`: installs and upgrades Claros in a Cloudflare account |
| `apps/dashboard` | React dashboard |

## Tenancy

Every product-owned table carries `tenant_id` (user-facing name: product) and every query is scoped by it; ingestion keys belong to one product. Up to v0.7 an install runs one product. Since v0.8 one instance can serve several products; users act on them through memberships, instance admins on all of them. See [Products](guide/PRODUCTS.md).

## Engine rules

- The LLM runs only at flow compile time and content draft time, never in the send path.
- Message state transitions use compare-and-swap on status; delivery feedback only moves forward.
- Suppression is checked before anything else at send time.
- Every outgoing message carries a compliant footer and, unless its topic kind is `transactional`, RFC 8058 one-click unsubscribe headers.
- A topic unsubscribe blocks that topic's mail (not transactional topics); a cloudflare transport sends transactional-topic mail only.
- Drain is round-robin across tenants so a large tenant cannot starve a small one.

## Capability differences between backends

| Capability | Postgres + Node | D1 + Workers |
|---|---|---|
| Knowledge base search | pgvector similarity when an embedding model is configured, full-text fallback | SQLite FTS5 (`bm25`) |
| Event storage | monthly partitioned `events` | plain `events` with a daily rollup and retention |
| Transports (several per product, routed by topic kind; Cloudflare Email Service for transactional mail only) | Resend, SMTP (nodemailer), Cloudflare Email Service (REST API) | Resend, SMTP (worker-mailer), Cloudflare Email Service (`send_email` binding, else REST API) |
| Custom domains from the CLI | no (use your reverse proxy) | yes |
| Scale target | larger installs; partitioned events (not benchmarked) | small and medium installs; one database per instance |

The running instance reports its capabilities at `GET /v1/capabilities`.
