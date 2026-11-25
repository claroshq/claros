# Install on Cloudflare Workers + D1

> Status: unreleased, planned for v0.8. This page describes the Workers runtime as it exists on the development branch. It is not part of a release yet, and parts of it do not work yet (see [Not available yet](#not-available-yet)). The released install path is Postgres + Node with Docker.

Claros can run as a single Cloudflare Worker on a D1 database, next to the Postgres + Node runtime. Both run the same engine and the same HTTP API; the Workers runtime is an additional install option, not a replacement for Postgres.

## What runs where

One Worker (`apps/worker`) has three handlers:

| Handler | Does | Node equivalent |
|---|---|---|
| `fetch` | The HTTP API (the same Hono app as the Node server) and the dashboard | `--role=api` |
| `queue` | Runs jobs from the `claros-jobs` queue, one job per message | `--role=worker` (pg-boss) |
| `scheduled` | One Cron Trigger every 5 minutes; enqueues the periodic jobs due at that tick | `--role=scheduler` (pg-boss schedules) |

Periodic jobs keep the Node schedules (all times UTC):

| Job | Runs |
|---|---|
| content generation | every 5 minutes |
| scan, drain, counter rollover | every 15 minutes |
| reap | hourly at :00 |
| retention grid snapshot | daily, on the 00:15 tick (00:17 on Node) |
| partition maintenance | not on D1 (it manages Postgres partitions) |

The roles talk only through the database and the job queue, as on Node: an event posted to `/v1/track` enqueues a trigger check, which chains enrollment, step advancement, content and sending through the queue.

## Bindings

The development template is `apps/worker/wrangler.jsonc`.

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 database | All Claros data. Migrations: `drizzle/migrations-sqlite`. |
| `JOBS` | Queue producer and consumer (`claros-jobs`) | Jobs. Failed jobs are retried with exponential backoff (base 10 seconds, at most 15 minutes) up to 3 times. |
| dead letter queue | Queue consumer (`claros-jobs-dlq`) | Jobs that failed every retry. They are logged with their payload. |
| `ASSETS` | Static Assets (`apps/dashboard/dist`) | The dashboard. |
| Cron Trigger | `*/5 * * * *` | Periodic jobs. |

Variables and secrets:

| Name | Kind | Notes |
|---|---|---|
| `BASE_URL` | var | Public URL of the Worker. Unsubscribe links in sent email point here. In production it must be an `https://` URL that is not localhost, or sending is blocked. |
| `DASHBOARD_URL` | var, optional | Defaults to `BASE_URL`. |
| `ENCRYPTION_KEY` | secret | 32 bytes, base64. Encrypts LLM and transport credentials at rest. |
| `UNSUBSCRIBE_SIGNING_KEY` | secret | 32 bytes, hex. Signs unsubscribe links. Never change it once mail has been sent. |

`NODE_ENV` is not a setting on Workers: wrangler fixes it when it bundles the Worker (`production` for a deploy, `development` under `wrangler dev`).

## Dashboard and the SPA fallback

Files that exist in the dashboard build are served by Cloudflare before the Worker runs. API paths (`/health`, `/version`, `/auth`, `/invite`, `/unsubscribe`, `/webhooks`, `/v1`) always reach the Worker first. Any other path the Worker does not know gets `index.html`, so client-side routes work; unknown API paths and non-GET requests get a JSON 404. These are the same rules as on Node.

## Try it locally with `wrangler dev`

`wrangler dev` runs the Worker, D1, the queues and the assets locally (Miniflare). Nothing in your Cloudflare account is used.

```bash
npm install
npm run build                                  # packages and the dashboard
cd apps/worker
cp .dev.vars.example .dev.vars                 # fill in ENCRYPTION_KEY and UNSUBSCRIBE_SIGNING_KEY
npx wrangler d1 migrations apply DB --local    # create the local D1 schema
npm run dev                                    # wrangler dev on http://localhost:8787
```

The Cron Trigger does not fire by itself under `wrangler dev`. Trigger a tick with:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"
```

`npm run build -w @claros/cloudflare-worker` bundles the Worker the way a deploy would (`wrangler deploy --dry-run`) without uploading anything.

## Not available yet

- Login, sessions, teams, invites, products and API key authentication on D1 are being implemented. Until they land, those routes answer 500 with "not implemented for D1 yet", so the dashboard cannot be used and `/v1/track` cannot authenticate a key on the Worker.
- First-account claim: the Node server prints a one-time claim URL at startup. A Worker has no startup step, so there is no claim URL on Workers yet.
- Deploying: a deploy command that creates the D1 database, the queues and the secrets is planned. The `wrangler.jsonc` in the repository is a development template with a placeholder database id.
- Transports: the Workers end-to-end test sends through the Resend adapter (against a fake Resend API). SMTP has not been tested on Workers.
- Knowledge base similarity search uses SQLite full-text search on D1 instead of pgvector.
