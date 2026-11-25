# Changelog

All notable changes to Claros are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release has a GitHub Release with the same notes and an upgrade section.

## [Unreleased]

### Added

- Date triggers (G3): flow triggers `date_property` (`{"property": "trial_ends_at", "offset": "-3d"}`) and `date_schedule` (`{"anchor": "first_paid_at", "offsets": ["1d", "3d", "7d"], "repeat": "30d", "max_sends": 7}`), with `send_at_local` (contact timezone, else the product's) and `where` conditions checked at every send. Declared `settings.date_traits` are indexed on identify (new table `contact_dates`); a contact enrolls once per date value; a moved or removed date exits the old enrollment (`date_changed`) and cancels its unsent messages. Step condition `{"date_unchanged": true}` and step `expires_after` (unsent messages are cancelled with reason `expired`). See [Flows](docs/guide/FLOWS.md#date-triggers).
- Context sources (G11): `settings.data_sources` and step `context`, `on_empty`, `on_error`. Claros posts a signed (Standard Webhooks) request at render time; the data is stored on the message, shown in approvals, and usable in templates (`{{context.*}}` with Mustache sections) and by the drafting model. Data source secrets are stored encrypted.
- Knowledge base v2 (G18, G15): entries gain `category`, `external_key`, `data`, `pinned`; step `kb_select` (`category`, `exclude_used`, `pick`, `tags_any_from_trait`) never sends an entry twice to a contact; pinned entries always reach the drafting model. `POST /v1/kb/import` (admin key scope `kb`) and `claros kb import <file> [--dry-run] [--force]` upsert by `external_key` without overwriting entries edited in Claros and never delete. See [Knowledge base](docs/guide/KB.md).
- Named links and checks on AI drafts (G19): `{{links.<name>}}` in templates and instructions; once a product declares `links` or tracked domains, a draft with any other URL fails with `status_reason = link_not_allowed`. `settings.brain.text_rules` accepts `{"find", "replace"}` and `{"forbid"}` rules applied after drafting (`text_rule_forbidden`), besides plain writing rules.
- Product guidelines and language (G22): `settings.brain.guidelines` reaches the drafting and value-gate models; the product `locale` sets the drafting language and the language of the mail footer and unsubscribe pages (English and Spanish).
- AI opening line in fixed templates (G29): a `{{brain.opening}}` slot gets one drafted line (at most 240 characters), shown in approvals. Templates without it make no LLM call.
- The `choose` step (G27): candidates with `when`, `kb_select`, `context`, `cooldown`; deterministic filters run first, the LLM picks one eligible candidate or none, and the decision (choice, eligible set, filtered-out reasons, reason) is stored on the message, shown in approvals and sent to the analytics sink as `choose_decided`. A product without an LLM cannot apply a choose step.
- History import (G21): `POST /v1/import/messages` (admin key scope `messages`) and `claros import messages <file.jsonl>` store a product's earlier sends as sent, imported messages that count for caps, re-entry, history conditions, cooldowns and KB deduplication. See [Importing send history](docs/guide/IMPORT.md).
- Messages API: `context_snapshot`, `choose`, `opening_line`, `kb_entry_id` and `imported` on messages.

- Multi-product instances: one install can serve several products, each with its own contacts, flows, settings and team. Existing installs keep one product and work as before. See [Products](docs/guide/PRODUCTS.md).
- Instance admins manage the install: they see every product, act on each as an owner, and create, rename and archive products (`GET/POST /v1/products`, `PATCH /v1/products/:slug`, `POST /v1/products/:slug/archive` and `/unarchive`) and instance settings (`GET /v1/instance`, `PUT /v1/instance/settings/:key`). The upgrade makes the active owners of the oldest product instance admins; the person who claims a fresh install is one.
- Dashboard requests pick a product with the `X-Claros-Product: <slug>` header or `?product=<slug>`; without either they act on the session's product, as before. The dashboard shows a product switcher when you can act on more than one product, and a Settings, Products page for instance admins.
- Archived products stay readable; dashboard API writes to them answer `409 {"error": "Product is archived."}`.
- Inviting an address that already belongs to a user of another product adds the product to that user (one login per person).
- `claros` npm package (`packages/cli`, unreleased, not published yet): `npx claros deploy` creates or updates a Claros instance on Cloudflare Workers + D1 (D1 database, queues, secrets, migrations, custom domains, first-account claim URL); also `upgrade`, `products set-host`, `doctor` and `claim-url`. Every step is idempotent and it never changes DNS records. See [Install on Cloudflare Workers + D1](docs/install/cloudflare.md).
- Product public hosts in mail: a product with a `public_host` gets `https://<public_host>` in the unsubscribe links of its mail (and of the test email) instead of `BASE_URL`. On a product's public host the unsubscribe pages answer only for that product's links (404 otherwise); the instance host keeps serving every product, so links already sent keep working.
- `GET /version` has an optional `version` field (the Claros release) when `CLAROS_VERSION` is set; `claros deploy` sets it. Without it the response is unchanged.
- Cloudflare Workers runtime (in progress, not usable yet): `apps/worker` runs the same API and job handlers as one Worker on D1, with Cloudflare Queues for jobs and one Cron Trigger for the periodic jobs. Login and API key authentication on D1 are not finished, so it cannot serve a product yet. Local trial with `wrangler dev`: see [Install on Cloudflare Workers + D1](docs/install/cloudflare.md). The Postgres + Node install is unchanged.

- Topics and consent: products can define topics (`marketing`, `lifecycle`, `transactional`) with `GET/POST /v1/topics` and `PATCH /v1/topics/:id`, and give a flow a topic (`topic_id` on flows). A contact unsubscribed from a topic, or not opted in to an opt-in topic, does not receive its mail (suppressed with `status_reason = topic_unsubscribed`); transactional topics ignore topic unsubscribes, and the suppression list still blocks everything. Identify `traits.topics` (`{ "<slug>": true | false }`) records consent; `GET /v1/contacts/:id` lists topic statuses as `topics`. Dashboard: Settings, Topics, a topic picker in the flow editor, and topic statuses on a person's page. See [Topics and consent](docs/guide/TOPICS.md).
- Unsubscribe per topic: the one-click link of a message with a marketing or lifecycle topic unsubscribes that topic only; links without a topic (all mail sent before this release, and messages without a topic) unsubscribe the whole product as before. The unsubscribe page lists the product's topics with checkboxes plus "Unsubscribe from all".
- Several transports per product with routing: `GET/POST /v1/settings/transports`, `PATCH/DELETE /v1/settings/transports/:id`, `POST /v1/settings/transports/:id/test` and `PUT /v1/settings/transport-routing` (`transactional`, `default`). Transactional-topic mail uses the transactional route, everything else the default route; without routing the oldest transport sends everything, as before. Transports gain an optional name and Reply-To; `daily_limit` applies per transport. Dashboard: Settings, Transports. See [Transports](docs/guide/TRANSPORTS.md).
- Cloudflare Email Service transport (`cloudflare`), for transactional mail only: the REST API with an account id and API token, or the Workers `send_email` binding `EMAIL`. A non-transactional message routed to it fails with `status_reason = transport_policy`, and routing refuses it as the default transport (400).
- SMTP on Cloudflare Workers uses `worker-mailer`.
- Resend sends carry `reply_to` (transport Reply-To, else the branding Reply-To) and tags `claros_tenant`, `claros_message_id` and `claros_flow`.
- Operational alerts (G25), on Postgres + Node and on Workers + D1: dead-lettered jobs, job exceptions, late periodic jobs, send error rates and provider authentication errors, approved mail left unsent (no usable transport or no `UNSUBSCRIBE_SIGNING_KEY`), Resend webhook failures and LLM error rates are recorded as events (kept 30 days) and grouped into alerts. Error and critical alerts are mailed within 5 minutes, repeats at most hourly, at most 10 alert mails per hour; a daily digest goes out at 07:00 UTC. Alert mail is transactional and goes through a product's transactional route. Settings `alerts.email` (default: the oldest instance admin), `alerts.enabled` and `alerts.via_product`. `GET /v1/instance/health`, `POST /v1/instance/alerts/:fingerprint/resolve` and `/mute`, and a Settings, Health page for instance admins. See [Alerts and health](docs/guide/ALERTS.md).

- Admin API keys (G1): owners create product admin keys (`clr_ak_...`) with scopes (`config`, `suppressions`, `messages`, `contacts:read`, `contacts:delete`, `broadcasts`, `kb`) under Integrate or with `POST /v1/ingestion/keys` `{"kind": "admin", "scopes": [...]}`. Management routes accept `Authorization: Bearer clr_ak_...` for the scopes the key carries, on the key's product only; ingestion keys never reach them and admin keys never write events. See [API keys](docs/guide/API_KEYS.md).
- Suppression API (G12): bulk `POST /v1/suppressions` `{"emails": [...], "reason": ...}`, `DELETE /v1/suppressions/:email` (complaint and hard-bounce suppressions only with `?force=1`), `GET /v1/suppressions?since=`, and `DELETE /v1/contacts/:external_id` to erase a contact with its events, memberships and messages.
- Approval actions (G20): edit a pending message (`PATCH /v1/messages/:id`, the drafted version is kept), regenerate it with an optional forced action type (`POST /v1/messages/:id/regenerate`), cancel an approved message (`/cancel`, new status `cancelled`) or send it back to review (`/unapprove`), and exclude a person (`POST /v1/contacts/:id/exclude`: suppression plus every unsent message cancelled). Messages record `approved_by`, `rejected_by` and `edited_by`. The queue lists critical flows first. The Approvals screen gains edit, regenerate, exclude, an "Approved, not sent yet" list and keyboard shortcuts (`j`/`k`, `a`, `r`, `e`). See [Approvals](docs/guide/APPROVALS.md).
- Trait and send-history conditions (G4, G28): `{trait: {key, op, value}}`, `{history: {flow | action_type | topic, within, op}}` and `{first_contact: true | false}` on step conditions, step and plan exits, and event triggers (`{event, where: [...]}`).
- Signed outbound webhooks (G5): `message.sent`, `delivered`, `opened`, `clicked`, `bounced`, `complained`, `failed`, `pending_approval` (batched, at most one per 15 minutes per endpoint), `contact.unsubscribed`, `resubscribed`, `suppressed`, `flow.enrolled`, `flow.exited`. Events are written to an outbox with the change they report and delivered with Standard Webhooks signatures, retried with backoff (1 minute to 12 hours) and marked dead after 12 attempts. New periodic job `claros.webhook-delivery`. See [Webhooks](docs/guide/WEBHOOKS.md).
- Analytics sink (G30): product setting `analytics` sends `flow_enrolled`, `flow_exited`, `email_sent`, `email_clicked`, `email_bounced`, `email_complained`, `email_unsubscribed` and `approval_decided` keyed to the contact's `external_id`, to StatsRaven (`/ingest`) or a webhook, through the same outbox. No open events.
- UTM tagging (G6): product setting `link_tracking` adds UTM parameters and `clr_cid=<message id>` to links on the product's domains when a message is sent; never on unsubscribe or footer links, never overwriting a parameter.
- Config as code (G2): `PUT /v1/config` (`?dry_run=1` for the diff) applies one JSON document of flows, templates, topics, transport routing by name, settings and webhooks, upserted by slug, atomically, bumping `config_version`; `prune: true` removes unlisted items. `GET /v1/config` exports the current configuration. `claros apply -f claros.config.json [--dry-run]` in the CLI. JSON Schema: `docs/reference/claros.config.schema.json`. See [Config as code](docs/guide/CONFIG.md).

### Changed

- Config documents reject unknown step fields instead of dropping them (stored and compiled plans are unchanged). `settings.data_sources` entries are validated (`url`, `secret`, `secret_ref` or `secret_env`, `timeout_ms`, `signature`, `modes`, `response_shape`).
- Embedding a knowledge base entry no longer changes its `updated_at` (the embedding is derived data, not an edit).
- List-Unsubscribe (D18): messages whose topic kind is `transactional` no longer carry the `List-Unsubscribe` and `List-Unsubscribe-Post` headers; their footer with the postal address and unsubscribe link is unchanged. Every other message, including every message without a topic, carries them as before.
- The branding Reply-To (`brand.reply_to`) is now sent as the Reply-To of mail when the transport has none. Before, it was stored but not used.
- With several transports, `PUT /v1/settings/transport` replaces the default transport only and `GET /v1/settings/transport` returns the default transport. A product with one transport sees no difference.
- First-account claim: the token is stored hashed in the new `claim_tokens` table instead of in the server's memory, and expires after 24 hours. The server still prints the claim URL at startup while no user exists and mints a new one on every restart (older unconsumed links stop working). Any API instance behind a load balancer can now serve the claim. On Workers, `/claim` is open while no user exists and uses tokens minted by `claros deploy` / `claros claim-url`.
- `GET /auth/me` reports the role and product (`tenantId`) of the product the request acts on. Without a product header this is the session's product, as before.

- New API keys get the prefixes `clr_pk_` (publishable) and `clr_sk_` (secret) instead of `cl_pub_` and `cl_live_`. Existing keys keep working.
- `GET /v1/messages` orders critical-class flows first, then oldest first, and adds the flow name and class, approval actors and the drafted version of edited messages to each message. Cursors from earlier responses keep working.
- Adding one address with `POST /v1/suppressions` `{"email": ...}` now also sends the `contact.suppressed` webhook; the stored row and the response are unchanged.

### Upgrade notes

- Migration `0027_integration_surface` (SQLite `0007`) adds `api_keys.scopes`, `flows.slug` (unique per product when set), the approval columns on `lifecycle_messages` (`approved_by`, `rejected_by`, `edited_by`, `edited_at`, `original_subject`, `original_body_html`, `original_body_text`, `forced_action_type`) and the `webhook_endpoints` and `webhook_outbox` tables. A new periodic job, `claros.webhook-delivery`, runs every minute on Postgres + Node (every 5-minute tick on Workers); it does nothing until a product configures a webhook or an analytics sink.

- Migration `0026_ops_alerts` (SQLite `0006`) adds the `ops_events` and `ops_alerts` tables. A new periodic job, `claros.alerts-digest` (daily 07:00 UTC), is scheduled on start. Installs without an alert recipient mail the oldest instance admin once a transport exists; set `alerts.enabled` to `false` to keep alerts on the Health page only.
- A permanent provider failure now records the provider's error as the message's `status_reason` (`provider_error: ...`), and the drain records the sending transport on the message before the send (`transport_id`), so failed sends are attributed to their transport.
- Migration `0025_topics_transports` (SQLite `0005`) adds the `topics` and `contact_topics` tables, nullable `flows.topic_id`, `lifecycle_messages.topic_id`, `transport_id` and `status_reason`, and nullable `transport_configs.kind`, `name` and `reply_to`; existing transports get `kind` = their provider. Nothing else changes until topics or a second transport are configured.
- Two database migrations, applied on boot or with `scripts/migrate.sh`. `0024_claim_tokens` only adds the `claim_tokens` table. `0023_instance_layer` only adds the `memberships` and `instance_settings` tables, new nullable `tenants` columns (`archived_at`, `public_host`, `locale`) and `config_version`, `users.instance_role`, and `api_keys.tenant_id` becomes nullable for future instance keys. It backfills one membership per existing user and the instance admins described above.

## [0.7.0] - 2026-11-25

This release changes how Claros is built and developed, not what it does. The HTTP API, the Docker install and the database are compatible with v0.6.

### Changed

- The HTTP layer moved from Fastify to [Hono](https://hono.dev), so the same API can later run on Cloudflare Workers. The HTTP API is unchanged: every v0.6 route, status code, response body and error shape is kept, and a route-parity test guards the v0.6 route list. On Node the server runs on `@hono/node-server`. One intended difference: every route now also answers with a trailing slash (`/health/` returned 404 before, now 200).
- Log output: the server still writes one JSON object per line for startup, warnings and errors, but no longer prints the two per-request access lines ("incoming request" / "request completed") Fastify emitted. Put a reverse proxy access log in front if you relied on them.
- The repository is now the single source of Claros development. Earlier releases were published here from a separate repository; the history and tags of this repository are kept.
- Contribution model: pull requests are now accepted and run the `check` workflow. See CONTRIBUTING.md.
- Development tooling moved from pnpm + turbo to npm workspaces (`npm install`, `npm run build`, `npm test`, `npm run check`). The Docker image and `docker compose` commands are unchanged for users.
- The guides moved from `guide/` to `docs/guide/`.
- `CLAROS_EDITION` is no longer read. Claros has one open-source edition; `/health`, `/version` and `/v1/diagnostics` still report `"edition": "community"` for compatibility.
- `CLAROS_SERVE_DASHBOARD` now defaults to `true` in every case (it was already `true` for every open-source install).
- The compose (dev-stage) container rebuilds the packages on every start, so the running code always matches the checked-out source after a `git pull`.

### Removed

- References to a hosted Cloud edition. There is no hosted Claros service.

### Upgrade notes

- No database migration is needed; existing data, keys and sessions keep working.
- Docker installs: `git pull`, then `docker compose build` and `docker compose up`. On the first start the container replaces the old pnpm-installed `node_modules` in your checkout with an npm install and rebuilds the packages (this needs network access once and takes a minute); later starts skip that step. You do not need to run `docker compose run --rm install` again.
- From source: delete `node_modules` and any `pnpm-lock.yaml` leftovers, then `npm install` and `npm run build`.
- If you set `CLAROS_EDITION`, you can remove it; it is ignored.

## [0.6.4] - 2026-08-14

See the [GitHub Release](https://github.com/claroshq/claros/releases/tag/v0.6.4).

## [0.6.3] - 2026-08-07

See the [GitHub Release](https://github.com/claroshq/claros/releases/tag/v0.6.3).

## [0.6.2] - 2026-08-07

See the [GitHub Release](https://github.com/claroshq/claros/releases/tag/v0.6.2).

## [0.6.1] - 2026-08-07

See the [GitHub Release](https://github.com/claroshq/claros/releases/tag/v0.6.1).

## [0.6.0] - 2026-08-07

See the [GitHub Release](https://github.com/claroshq/claros/releases/tag/v0.6.0).

Earlier releases (v0.0.1 to v0.5.2) are listed on the [releases page](https://github.com/claroshq/claros/releases) and as tags.

[Unreleased]: https://github.com/claroshq/claros/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/claroshq/claros/compare/v0.6.4...v0.7.0
[0.6.4]: https://github.com/claroshq/claros/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/claroshq/claros/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/claroshq/claros/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/claroshq/claros/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/claroshq/claros/compare/v0.5.2...v0.6.0
