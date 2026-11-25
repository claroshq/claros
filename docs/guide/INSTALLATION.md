# Installation and Configuration

The complete reference for running Claros. For a guided first run, start with [QUICKSTART.md](./QUICKSTART.md) and come back here for depth.

Contents:

- [Ways to run](#ways-to-run)
- [Environment variables](#environment-variables)
- [Configuration](#configuration) (transport, LLM, throttle, team)
- [Operator CLI](#operator-cli)
- [Migrations](#migrations)
- [Upgrading](#upgrading)
- [Backups](#backups)
- [Scaling with roles](#scaling-with-roles)
- [Removing everything](#removing-everything)

---

## Ways to run

This guide covers the Postgres + Node install: a single Docker image plus Postgres. Claros also runs on Cloudflare Workers + D1 (since v0.8); see [Install on Cloudflare Workers + D1](../install/cloudflare.md). There are three practical ways to run the Postgres + Node install.

### 1. Docker Compose (recommended)

The compose stack in the repository root runs the app and a Postgres 16 + pgvector database, applies migrations on boot, and builds the dashboard.

```bash
git clone https://github.com/claroshq/claros.git && cd claros
docker compose run --rm install   # creates .env with generated secrets, chowns to directory owner
docker compose up
```

The `install` command prepares `.env` with generated secrets, tests the database connection, and applies schema migrations. It is safe to run again (only fills missing values).

- App: `http://localhost:3000` (override with `PORT` in `.env`)
- Postgres: exposed on host port `5433` (so it never collides with a host Postgres on 5432)
- The compose file sets `NODE_ENV=development` and `CLAROS_MIGRATE_ON_BOOT=true`
- Data persists in the `pgdata` named volume

The compose stack mounts `./apps`, `./packages`, and `./drizzle` into the container and runs the server in watch mode. It is a development-friendly default. For a production deployment, use the published image (below) with `NODE_ENV=production`.

### 2. Published image

A multi-role image is published to GHCR with each release:

```bash
docker run -d \
  -e DATABASE_URL=postgres://user:pass@your-db-host:5432/claros \
  -e NODE_ENV=production \
  -e CLAROS_MIGRATE_ON_BOOT=true \
  -e SEED_ADMIN_EMAIL=admin@yourcompany.com \
  -e ENCRYPTION_KEY=<base64-32-bytes> \
  -e UNSUBSCRIBE_SIGNING_KEY=<hex-32-bytes> \
  -e BASE_URL=https://claros.yourcompany.com \
  -p 3000:3000 \
  ghcr.io/claroshq/claros:v0.5.2 \
  --role=all
```

Requirements for this path:

- Your own Postgres 16+ with the `vector` extension available (the server runs `CREATE EXTENSION IF NOT EXISTS` via migrations)
- `BASE_URL` set to the public HTTPS URL. In production the send worker refuses to send when `BASE_URL` is loopback or non-HTTPS, because unsubscribe links would be broken
- In production there is no console login fallback, so either configure a transport first (magic links are emailed) or use `claros login-link` (below) against the database

If the GHCR package is not yet public at the time you read this, use Docker Compose, which builds from source and needs no registry credentials.

### 3. From source

Requires Node.js 22+ (with npm), plus a Postgres 16 with pgvector.

```bash
npm install
cp .env.example .env   # set DATABASE_URL, ENCRYPTION_KEY, UNSUBSCRIBE_SIGNING_KEY
npm run db:migrate        # applies migrations to DATABASE_URL
npm run build
npm run dev               # all roles in watch mode (--role=all); API on :3000, dashboard dev server on :5173
```

The Vite dev server proxies `/v1` and `/auth` to the API on port 3000. In a built deployment the API serves the dashboard itself and there is no separate dev server.

Other root scripts: `npm test` (unit tests need no database; `*.db.test.ts` integration tests need `DATABASE_URL`), `npm run typecheck`, `npm run lint`, `npm run db:generate` (authors a new migration after schema changes).

---

## Environment variables

All variables are read by the server process unless noted. The only hard requirement is `DATABASE_URL`.

### Core

| Variable | Default | What it does | Get it wrong |
|---|---|---|---|
| `DATABASE_URL` | none (required) | Postgres connection string. Used by the app, the job queue, and migrations | Server exits at boot. Pooled endpoints (pgbouncer, `-pooler` hosts) are refused: the job queue needs direct connections |
| `PORT` | `3000` | HTTP listen port | Compose maps `${PORT:-3000}:3000`, so set it in `.env` to move the app |
| `HOST` | `0.0.0.0` | HTTP bind address | Rarely changed |
| `SEED_ADMIN_EMAIL` | none | Optional. When set and the tenants table is empty, creates the `default` tenant and this address as its owner at boot (automated provisioning path). When unset, the server logs a one-time claim URL for browser-based first login | Ignored once any tenant exists. Unset = claim flow active |
| `NODE_ENV` | unset (treated as production) | `development` enables the console magic-link fallback (login links printed to logs when no transport is configured). `production` sets the `Secure` cookie flag and enforces production URL checks | Unset means production behavior: no console login links. The published image sets `production` |
| `LOG_LEVEL` | `info` | Fastify log level | - |

### Secrets

| Variable | Default | What it does | Get it wrong |
|---|---|---|---|
| `ENCRYPTION_KEY` | none | AES-256-GCM key for transport and LLM credentials at rest. Generate: `openssl rand -base64 32` | Server boots with a warning, but saving transport/LLM settings, flow compilation, and KB embeddings fail at first use. Losing it makes all stored credentials unreadable; back it up with the database |
| `UNSUBSCRIBE_SIGNING_KEY` | none | HMAC key signing one-click unsubscribe tokens. Generate: `openssl rand -hex 32` | Sending fails closed: messages stay `approved` and the drain skips them. Once real email has been delivered, changing it breaks unsubscribe links already in inboxes. Treat as permanent |

### URLs

| Variable | Default | What it does | Get it wrong |
|---|---|---|---|
| `BASE_URL` | `http://localhost:3000` | Public base URL of the API. Baked into unsubscribe links and magic links | In production the drain refuses to send with a loopback or non-HTTPS `BASE_URL`. Must be the URL recipients' mail clients can reach |
| `DASHBOARD_URL` | falls back to `BASE_URL` | Where users land after login. Only needed if the dashboard lives on a different origin than the API | Login redirects to the wrong place |

### Behavior toggles

| Variable | Default | What it does | Get it wrong |
|---|---|---|---|
| `CLAROS_MIGRATE_ON_BOOT` | off | When exactly `true`, applies pending migrations at startup. Set in the compose stack | Off + never running `npm run db:migrate` = schema drift and boot/query failures after upgrades. On is safe for single-instance deploys; for multi-replica deploys run migrations out of band instead |
| `CLAROS_SERVE_DASHBOARD` | `true` | Serves the built dashboard SPA from the API process | Set `false` only if you serve the SPA elsewhere |
| `CLAROS_DASHBOARD_DIST` | auto-detected | Overrides the dashboard build directory | Rarely needed |
| `CLAROS_EDITION` | `community` | Edition marker. `cloud` is for the hosted service and requires private packages | Setting `cloud` on a community checkout stops the boot |
| `PRODUCTION_DATABASE_URL` | none | Target database for `claros --prod` and migration tooling pointed at production | Only read when `--prod` is passed |
| `CLAROS_COMMIT_SHA` / `CLAROS_BUILT_AT` | `unknown` / null | Build provenance reported by `/version`; set by the image build | - |

### Not environment variables

Worth stating explicitly, because people look for them:

- There are no `OPENAI_API_KEY` or SMTP password environment variables. LLM and transport credentials are per-tenant, entered via the dashboard or `claros`, and stored encrypted in the database.
- No timing is env-tunable. Worker poll intervals and cron schedules are fixed in code (see [Timing](#timing)).

---

## Configuration

Everything below lives in the database per tenant and is managed from the dashboard (Settings) or the `claros` CLI.

### Email transport

One active transport per tenant. Two providers are supported.

**Resend** - API-based, and the only transport with feedback (opens, clicks, bounces, complaints) via webhook.

```bash
echo '{"provider":"resend","from_email":"you@yourdomain.com","from_name":"You","api_key":"re_...","webhook_secret":"whsec_..."}' \
  | docker compose exec -T app claros transport set default
```

- `from_email` (required) must be on a domain verified in Resend
- `webhook_secret` (optional but recommended): the Svix signing secret from your Resend webhook configuration. The webhook URL to register in Resend is `https://<your-host>/webhooks/resend/<tenantId>`. Find your tenant ID with `GET /auth/me` (the `user.tenantId` field) while logged in, or with `docker compose exec postgres psql -U claros -c 'SELECT id, slug FROM tenants;'`
- Without the webhook, email still sends; you simply get no open/click/bounce data

**SMTP** - any standards-based server, including the Amazon SES SMTP endpoint.

```bash
echo '{"provider":"smtp","from_email":"you@yourdomain.com","host":"email-smtp.us-east-1.amazonaws.com","port":587,"username":"...","password":"..."}' \
  | docker compose exec -T app claros transport set default
```

- `port` 465 implies implicit TLS; other ports use STARTTLS when offered
- `username`/`password` optional for unauthenticated relays
- The connection is verified (EHLO + AUTH) before the config is saved
- SMTP has no feedback channel: no open/click/bounce data, ever. If you want tracking, use Resend

Both providers accept an optional `daily_limit` (integer, minimum 1). When the day's sent count hits the limit, remaining messages are deferred 24 hours.

Changing transport replaces the active row; old credentials stay in the table (inactive) until you clean them up.

### LLM provider

Optional. Required only for prompt-defined flow compilation, AI-drafted content, and KB embeddings. Configured at Settings → LLM or:

```bash
echo '{"provider":"openai","api_key":"sk-...","model":"gpt-4o-mini"}' \
  | docker compose exec -T app claros llm set default
```

| Provider | Default base URL | Default model | Notes |
|---|---|---|---|
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` | Embeddings via `text-embedding-3-small` |
| `anthropic` | `https://api.anthropic.com/v1` | `claude-sonnet-4-6` | Uses Anthropic's OpenAI-compatible endpoint; no embeddings endpoint, so KB features need a second provider |
| `ollama` | `http://localhost:11434/v1` | `llama3` | Local models; embedding dimension rarely matches the required 1536, so KB embeddings are effectively OpenAI-only |
| `custom` | (required) | (required) | Any OpenAI-compatible `/v1/chat/completions` endpoint: Gemini, Groq, vLLM, Azure, etc. |

The embedding model defaults to `text-embedding-3-small` and must produce 1536-dimensional vectors. Credentials are verified against the provider with a minimal API call before being saved, and stored encrypted.

Costs: compilation is one call per prompt change. AI content is three calls (decide, draft, assess) per message per contact. That is why `gpt-4o-mini` is the default.

### Postal address and tenant settings

- `postal_address` (required to send): footer of every email. `claros postal-address set default` or Settings → Postal.
- Branding (Settings → Branding): brand name, logo URL, logo height (16-64 px), accent color, footer text, reply-to address.
- `brain_context` (Settings): up to 4,000 characters of free text about your product, injected into compile and draft prompts. This is how the AI learns what your product does.

### Throttle and send window

Settings → Pace, or `PUT /v1/settings/throttle` (owner only). Defaults and allowed ranges:

| Setting | Default | Range | Meaning |
|---|---|---|---|
| `max_emails_per_user_per_day` | 1 | 0-100 | Per-contact daily cap across all flows |
| `max_emails_per_user_per_week` | 2 | 0-500 | Per-contact weekly cap |
| `min_interval_between_emails_hours` | 48 | 0-168 | Minimum gap between any two emails to one contact |
| `send_window_start` / `send_window_end` | 09:00 / 17:00 | HH:MM, end after start | Allowed sending hours |
| `send_window_days` | Mon-Fri | non-empty subset | Allowed sending days |
| `send_window_timezone` | `contact_local` | `contact_local` or `tenant_fixed` | Whose clock the window follows. `tenant_fixed` requires `tenant_timezone` |
| `batch_size_per_tick` | 10 | 1-100 | Max messages sent per tenant per drain tick (every 15 minutes) |

Two rules cannot be changed: the drain runs every 15 minutes, and critical-class flows always bypass the frequency caps and send window (suppression is still enforced). Nurture-class steps marked `immediate` bypass the send window only; frequency caps still apply.

### Team and roles

Two roles: `owner` and `member`.

- Owner-only: transport, LLM, postal/branding, throttle settings, test email, inviting/removing members, changing roles
- Everything else (flows, approvals, contacts, KB, suppressions, ingestion keys, analytics) is available to both

The system always requires at least one active owner: the last owner cannot be demoted or removed. Invites are by email from Settings → Team (7-day expiry), delivered through your configured transport. If no transport exists yet, use the CLI:

```bash
echo '{"email":"teammate@example.com","role":"member"}' \
  | docker compose exec -T app claros user create default
docker compose exec app claros login-link teammate@example.com
```

There is no self-service signup. Since v0.8 an instance can serve several products: instance admins create them in Settings, Products. See [PRODUCTS.md](./PRODUCTS.md).

---

## Operator CLI

`claros` is installed inside the app container. It talks directly to the database, so it works even when the server is down, and it never prints stored credentials.

```bash
docker compose exec app claros <command>          # server running
docker compose run --rm --entrypoint claros app <command>   # one-shot container
```

| Command | Purpose |
|---|---|
| `claros install` | Machine-level setup: creates .env (mode 0600, chowned to directory owner), generates secrets, tests DB, runs migrations. Run via `docker compose run --rm install`. Add `--database-url` for external Postgres. Override ownership with `CLAROS_UID=$(id -u) CLAROS_GID=$(id -g)` if auto-detection does not produce the right owner |
| `claros doctor [--url <url>]` | Read-only diagnostics: version provenance, migration state, transport decryption, key fingerprints. Run after every deploy |
| `claros login-link <email>` | One-time login URL (10-minute expiry). The account recovery tool |
| `claros setup [tenant_slug]` | Guided wizard: postal address, LLM, transport. Safe to re-run |
| `claros transport set <slug>` / `show` | Write / inspect the email transport |
| `claros llm set <slug>` / `show` | Write / inspect the LLM provider |
| `claros postal-address set <slug>` / `show` | Set / inspect the postal address |
| `claros user list <slug>` | List active users |
| `claros user create <slug>` | Create or reactivate a user (owner or member) |
| `claros user promote <slug> <email>` | Promote a user to owner |

All `set` and `create` commands accept JSON on stdin for automation (`echo '{...}' | claros transport set default`), prompt interactively on a TTY, and require typed confirmation when run with `--prod` against `PRODUCTION_DATABASE_URL`.

---

## Migrations

- Schema is managed by Drizzle; migration files live in `drizzle/migrations`.
- Compose sets `CLAROS_MIGRATE_ON_BOOT=true`, so the stack migrates itself on every start. Nothing else to do.
- From source: `npm run db:migrate` applies pending migrations to `DATABASE_URL`.
- Published image, single instance: set `CLAROS_MIGRATE_ON_BOOT=true`.
- Published image, multiple replicas: do not let every replica migrate. Run the migration once from a checkout (`npm run db:migrate`) or a one-off container, then roll the replicas.

Migrations are expand-contract: new code always works against the previous schema, and destructive changes ship in a later release than the code that stopped needing the old shape. Upgrading by one release at a time is always safe.

`claros doctor` reports whether the database is behind on migrations.

## Upgrading

Compose / source checkout:

```bash
git pull
docker compose up -d --build    # compose remigrates on boot
```

Published image: pull the new tag, recreate the container. With `CLAROS_MIGRATE_ON_BOOT=true` the schema updates itself; otherwise run `npm run db:migrate` first.

There is no downgrade path for the schema. Take a backup before upgrading (below), and read the release notes on the [releases page](https://github.com/claroshq/claros/releases); that page is the changelog.

## Backups

Everything Claros owns lives in one Postgres database: contacts, events, flows, compiled plans, messages, suppressed addresses, encrypted credentials, sessions. There is no other state.

```bash
docker compose exec postgres pg_dump -U claros claros > claros-backup-$(date +%F).sql
```

Back up alongside the database:

- `ENCRYPTION_KEY` - without it, restored transport and LLM credentials are undecryptable
- `UNSUBSCRIBE_SIGNING_KEY` - without it, unsubscribe links in already-delivered mail stop validating

Restore: load the dump into a fresh Postgres with pgvector, point `DATABASE_URL` at it, start the app.

## Scaling with roles

One container runs everything (`--role=all`, the default). Under load you can split roles; roles communicate only through Postgres, so any combination works:

```bash
# one or more API containers
docker run ... ghcr.io/claroshq/claros:v0.5.2 --role=api
# one or more worker containers
docker run ... ghcr.io/claroshq/claros:v0.5.2 --role=worker
# exactly one scheduler
docker run ... ghcr.io/claroshq/claros:v0.5.2 --role=scheduler
```

Rules: exactly one scheduler (it registers the cron jobs; duplicates double-schedule), any number of API and worker replicas. The bootstrap seed only runs in `all` and `api`.

## Timing

Fixed in code, not configurable:

- Event-triggered flow enrollment: near-instant (job queued by ingestion, workers poll every 2 seconds)
- Lifecycle-transition and segment-triggered enrollment: up to 15 minutes (scan tick)
- Content generation: near-instant for queued messages; 5-minute sweep as backstop
- Drain (sending): near-instant on approval; 15-minute sweep as backstop
- Stuck-message reap: hourly

## Removing everything

```bash
docker compose down -v   # removes containers and the pgdata volume (all data)
```

---

Next: [CONCEPTS.md](./CONCEPTS.md) for the mental model, [FAQ.md](./FAQ.md) for when something is wrong.
