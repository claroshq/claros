# Install on Cloudflare Workers + D1

> Available since v0.8. Known limits are listed under [Known limits](#known-limits). Postgres + Node with Docker remains a fully supported install option.

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

The development template is `apps/worker/wrangler.jsonc`; `claros deploy` generates the deployed configuration from the same bindings.

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
| `CLAROS_VERSION` | var | Set by `claros deploy`; reported as `version` by `GET /version`. |
| `ENCRYPTION_KEY` | secret | 32 bytes, base64. Encrypts LLM and transport credentials at rest. |
| `UNSUBSCRIBE_SIGNING_KEY` | secret | 32 bytes, hex. Signs unsubscribe links. Never change it once mail has been sent. |

`NODE_ENV` is not a setting on Workers: wrangler fixes it when it bundles the Worker (`production` for a deploy, `development` under `wrangler dev`).

## Dashboard and the SPA fallback

Files that exist in the dashboard build are served by Cloudflare before the Worker runs. API paths (`/health`, `/version`, `/auth`, `/invite`, `/unsubscribe`, `/webhooks`, `/v1`) always reach the Worker first. Any other path the Worker does not know gets `index.html`, so client-side routes work; unknown API paths and non-GET requests get a JSON 404. These are the same rules as on Node.

## Deploy with `npx claros deploy`

From a checkout of the repository you can run the same CLI without npm: `npm run build`, then `node packages/cli/bin/claros.mjs` in place of `npx claros`.

`claros deploy` creates or updates one Claros instance in your Cloudflare account. It runs wrangler with your Cloudflare login (`npx wrangler login`, or `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in CI) and never changes DNS records.

```bash
npx claros deploy --domain claros.example.com
```

| Option | Meaning |
|---|---|
| `--name <instance>` | Instance name, default `default`. Resources are named `claros-<name>`. |
| `--domain <host>` | Custom domain for the instance. Without it the Worker is served on `claros-<name>.<your-subdomain>.workers.dev`. |
| `--account <id>` | Cloudflare account id or name, when your login has several. |
| `--non-interactive` | Never prompt (CI). |
| `--dry-run` | List what would change and change nothing. |
| `--force` | Deploy the Worker even when nothing changed. |

Every step checks what exists and changes only what is missing, so running the command again is safe; a second run with nothing to do changes nothing.

1. Finds or creates the D1 database `claros-<name>` and the queues `claros-<name>-jobs` and `claros-<name>-jobs-dlq`.
2. Writes the Worker configuration to `~/.config/claros/<name>/wrangler.jsonc`: the bindings above, the Cron Trigger, the dashboard assets, `BASE_URL`, and a custom domain route for `--domain` and for each product public host (see below).
3. Sets `ENCRYPTION_KEY` and `UNSUBSCRIBE_SIGNING_KEY` on the Worker when they are missing. Existing secrets are never overwritten. New values are written to `~/.config/claros/<name>.json` (mode 600): back that file up. Losing `UNSUBSCRIBE_SIGNING_KEY` breaks unsubscribe links in mail already sent; losing `ENCRYPTION_KEY` makes stored credentials unreadable.
4. Applies pending D1 migrations (`wrangler d1 migrations apply --remote`).
5. Deploys the Worker and waits until `https://<host>/version` reports the deployed version. A new custom domain can take a few minutes to get its certificate.
6. While no user exists, prints a one-time claim URL (valid for 24 hours) to create the first owner account. `npx claros claim-url` prints a new one.
7. Prints the next steps: the email transport in Settings, the Resend webhook URL (`https://<host>/webhooks/resend/<product id>`, shown in Settings, Transport).

`~/.config/claros/<name>.json` caches the account, resource ids and host. Everything in it except the generated secrets is found again on Cloudflare by name, so a missing file is fine.

Before attaching a custom domain the command asks Cloudflare which hosts are in use. When a host already has a DNS record, or is a custom domain of another Worker, it stops and names the host instead of replacing the record; remove the record or pick another host and run it again.

When the command cannot confirm a Workers Paid plan, it prints the Workers Free limits: D1 and Queues have daily limits, and Cloudflare Email Service sends to arbitrary recipients only on Workers Paid.

### Other commands

| Command | Does |
|---|---|
| `npx claros upgrade [--name]` | Refuses a downgrade, backs up D1 (see [Upgrade backups](#upgrade-backups)), applies migrations, deploys the package's version and waits for it. If the new version does not come up, it rolls the Worker back (`wrangler rollback`); migrations are additive and stay applied. |
| `npx claros products set-host <slug> <host> [--name]` | Sets the product's public host and redeploys with a custom domain route for it. |
| `npx claros doctor [--name]` | Checks the secrets, pending migrations, HTTPS on every route, `/health` and `/version`. |
| `npx claros claim-url [--name]` | Prints a new one-time claim URL while no user exists. |

### Upgrade backups

Right before it applies migrations, `claros upgrade` takes two backups of the D1 database:

1. A D1 Time Travel bookmark (`wrangler d1 time-travel info`). It covers the whole database, including the knowledge-base search index. The command prints it with the restore command, and the state file keeps it as `lastUpgradeBackup` (bookmark, time, versions before and after).
2. An SQL export of the regular tables to `~/.config/claros/<name>/backups/<time>-<version>.sql`. `wrangler d1 export` cannot export virtual tables, so the export leaves out the FTS5 knowledge-base search index (`kb_fts` and its internal tables).

If one of them fails, the command warns and goes on with the other. If both fail, it stops before applying any migration.

To restore from the bookmark (this replaces the database's current contents; Time Travel keeps bookmarks only for its retention period, see [Cloudflare's Time Travel docs](https://developers.cloudflare.com/d1/reference/time-travel/)):

```bash
npx wrangler d1 time-travel restore claros-<name> --bookmark <bookmark>
```

Roll the Worker back to the matching version as well (`npx wrangler rollback`), since the restored schema is the one the earlier version used.

To restore from the SQL file, load it into an empty D1 database and rebuild the search index, which the file does not contain:

```bash
npx wrangler d1 execute <database> --remote --file ~/.config/claros/<name>/backups/<file>.sql
npx wrangler d1 execute <database> --remote --command "INSERT INTO kb_fts(kb_fts) VALUES('rebuild')"
```

If `kb_fts` does not exist in that database, create it first with the statements of `drizzle/migrations-sqlite/0001_kb_fts.sql` (the virtual table, and its triggers if they are missing), then run the rebuild.

### Product public hosts

A product with a public host (`public_host`, set with `claros products set-host` or `PATCH /v1/products/:slug`) gets `https://<public host>` in the unsubscribe links of its mail instead of `BASE_URL`. On that host the unsubscribe pages answer only for that product's links (404 for others). Links on the instance host keep working for every product, including mail sent before the host was set. On Workers a host set through the API gets its route at the next `claros deploy`; until then its links do not resolve, so prefer `claros products set-host`. On Node, point the host at the server yourself (DNS and reverse proxy).

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

## Known limits

- `claros deploy` is tested against a simulated Cloudflare account in CI and was verified against a real account before the v0.8.0 release. The `wrangler.jsonc` in `apps/worker` is a development template with a placeholder database id; deployed configuration comes from `claros deploy`.
- Moving an existing Postgres install to D1 is not supported; Postgres installs stay on Postgres and upgrade in place.
- Transports: the Workers end-to-end test sends through the Resend adapter (against a fake Resend API). SMTP has not been tested on Workers.
- Knowledge base similarity search uses SQLite full-text search on D1 instead of pgvector.
