# Changelog

All notable changes to Claros are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release has a GitHub Release with the same notes and an upgrade section.

## [Unreleased]

## [0.8.6] - 2026-11-25

### Added

- Dashboard product picker. With two or more active products, signing in or opening a new tab shows a full-screen picker before the app: one card per product (name, slug, public host, role), the last chosen product highlighted, arrow keys, Enter and `1` to `9`. Archived products sit in a collapsed group and open read-only; instance admins can create a product there. The picker shows once per tab; `/products` opens it any time. See [Products](docs/guide/PRODUCTS.md#opening-and-switching-products-in-the-dashboard).
- `GET /v1/products` returns each product's `public_host` (additive field).

### Changed

- With exactly one active product the dashboard opens it directly, even when the user's home product or last used product is archived (before, it opened the archived product).
- The sidebar product switcher is a menu: monogram, name and slug or public host per product, a check on the open product, a filter field above six products, keyboard navigation, and "All products" and (instance admins) "New product" actions. It lists active products only; archived products open from the picker or Settings, Products, and an open archived product is tagged "archived".
- Docs: the Quickstart covers both install paths (Docker + Postgres and Cloudflare Workers + D1) side by side, tracking a first event and adding a second product. Installation gains a "Choose a runtime" comparison, a Cloudflare section and Workers upgrades. README presents multi-product instances; Products and Concepts describe the picker, product selection in the API and archiving.

## [0.8.5] - 2026-11-25

### Added

- Brand logo upload: upload the product's logo (PNG or JPEG, at most 256 KB) in Settings, Branding, or with `POST /v1/settings/brand/logo` (the image is the request body; owner session or an admin key with the `config` scope). Claros stores it in the database (Postgres `bytea`, D1 `BLOB`, new table `brand_assets`) and serves it without authentication at `/brand/logo` on the product's public host and at `/brand/<product slug>/logo` on the instance host, so the logo in mail no longer depends on another site staying reachable. The upload sets `brand.logo_url` to the hosted URL with a `?v=` content hash (cached for a year) and, when unset, `brand.logo_height` from the image. Older `?v=` URLs keep showing the current logo. SVG and other types answer `415`, larger files `413`. `GET /v1/settings/brand/logo` returns the logo's details and `DELETE` removes it. An external `brand.logo_url` still works and replaces the upload in mail; `GET /v1/config` exports the hosted URL, so applying an export again changes nothing. `GET /v1/capabilities` lists the feature `brand_logo_upload`. Same behaviour on Postgres and D1; Workers installs need `npx @claroshq/claros upgrade` (the new migration and the `/brand/*` route). See [Brand logo](docs/guide/INSTALLATION.md#brand-logo).

## [0.8.4] - 2026-11-25

### Added

- `settings.lifecycle.engagement_events`: the `track` event names that count as activity. When set, only those events update a contact's last seen time, count toward engagement depth and move contacts back to `engaged` (or `churned` to `resurrected`), and `identify` no longer counts as activity. Events outside the list are still stored, still trigger flows, still count for `activation_events` and still feed conditions and history. Unset or empty keeps the previous behaviour: every `track` and `identify` counts. Set it in the config document (`claros apply`, `PUT /v1/config`); the config schema and `GET /v1/capabilities` (feature `engagement_events`) include it. Same behaviour on Postgres and D1. See [Activity and lifecycle states](docs/guide/CONCEPTS.md#activity-and-lifecycle-states).

## [0.8.3] - 2026-11-25

### Changed

- The CLI is published on npm as `@claroshq/claros` (the unscoped name `claros` belongs to another package). Run it with `npx @claroshq/claros <command>` (for example `npx @claroshq/claros upgrade`), or install it with `npm i -g @claroshq/claros`, which still gives you the `claros` command. Commands and options are unchanged. Wherever earlier release notes say `npx claros ...`, use `npx @claroshq/claros ...`.

### Fixed

- `POST /v1/kb/import` and `POST /v1/import/messages` accept JSONL sent as `application/x-ndjson`, `application/jsonl` or `application/x-jsonlines`, in addition to `text/plain` and JSON. Before, those media types got `415 Unsupported Media Type`.

## [0.8.2] - 2026-11-25

### Fixed

- `claros deploy` and `claros upgrade` now add the Cloudflare Email Service `send_email` binding `EMAIL` to the generated Worker configuration, so a `cloudflare` transport works on a CLI-installed instance without an API token. Onboard the sender domain to Email Service in the Worker's account, then add a `cloudflare` transport without `account_id` and `api_token`; it carries transactional topics only. A `cloudflare` transport stored with an `account_id` and `api_token` keeps using the REST API with those credentials, also when the Worker has the binding. Run `npx claros upgrade` on existing instances. See [Cloudflare Email Service on a Workers install](docs/guide/TRANSPORTS.md#cloudflare-email-service-on-a-workers-install).

## [0.8.1] - 2026-11-25

### Fixed

- `claros upgrade` no longer aborts before migrating on every D1 database: `wrangler d1 export` refuses databases with virtual tables, and the knowledge-base search index (`kb_fts`) is an FTS5 table. The upgrade now records a D1 Time Travel bookmark before migrating (printed with its restore command and kept in the state file) and exports only the regular tables to the SQL backup. A failed export only warns; the upgrade stops before migrating only when neither backup could be taken. After restoring from the SQL file, rebuild the search index with `INSERT INTO kb_fts(kb_fts) VALUES('rebuild')`; see [Upgrade backups](docs/install/cloudflare.md#upgrade-backups).

## [0.8.0] - 2026-11-25

Claros 0.8 adds a second install option, Cloudflare Workers + D1 (`npx claros deploy`), next to Postgres + Node with Docker, which stays fully supported. Both run the same HTTP API and engine. One instance can now serve several products, each with topics and consent, several transports with routing, admin keys, config as code, signed webhooks and an analytics sink, and the engine gains date schedules, a context hook, knowledge base v2, the `choose` step and send-history import. Postgres installs upgrade in place: the v0.6 and v0.7 HTTP API, ingest contract, Docker environment variables and data keep working. Read the upgrade notes for the behaviour changes.

### Added

#### Install options

- Cloudflare Workers + D1 as an additional install option. `apps/worker` runs the same API and job handlers as one Worker on D1, with Cloudflare Queues for jobs, one Cron Trigger for the periodic jobs and the dashboard as Static Assets. Local trial with `wrangler dev`. The Postgres + Node install is unchanged. See [Install on Cloudflare Workers + D1](docs/install/cloudflare.md).
- `claros` npm package (`packages/cli`): `npx claros deploy` creates or updates a Claros instance on Cloudflare Workers + D1 (D1 database, queues, secrets, migrations, custom domains, first-account claim URL); also `upgrade`, `products set-host`, `doctor` and `claim-url`. Every step is idempotent and it never changes DNS records.
- `GET /v1/capabilities`: backend, runtime, knowledge base search, events partitioning, transport kinds and a list of feature ids.
- `GET /version` has an optional `version` field (the Claros release) when `CLAROS_VERSION` is set; `claros deploy` sets it. Without it the response is unchanged.

#### Products and instance administration

- Multi-product instances: one install can serve several products, each with its own contacts, flows, settings and team. Existing installs keep one product and work as before. See [Products](docs/guide/PRODUCTS.md).
- Instance admins manage the install: they see every product, act on each as an owner, and create, rename and archive products (`GET/POST /v1/products`, `PATCH /v1/products/:slug`, `POST /v1/products/:slug/archive` and `/unarchive`) and instance settings (`GET /v1/instance`, `PUT /v1/instance/settings/:key`). The upgrade makes the active owners of the oldest product instance admins; the person who claims a fresh install is one.
- Dashboard requests pick a product with the `X-Claros-Product: <slug>` header or `?product=<slug>`; without either they act on the session's product, as before. The dashboard shows a product switcher when you can act on more than one product, and a Settings, Products page for instance admins.
- Archived products stay readable and stop: dashboard API writes answer `409 {"error": "Product is archived."}`, `POST /v1/track`, `/v1/identify` and `/v1/batch` answer `403 {"error": "Product is archived."}`, the scan skips them and the drain does not send their approved messages. Unarchiving resumes both.
- Inviting an address that already belongs to a user of another product adds the product to that user (one login per person).
- Product public hosts in mail: a product with a `public_host` gets `https://<public_host>` in the unsubscribe links of its mail (and of the test email) instead of `BASE_URL`. On a product's public host the unsubscribe pages answer only for that product's links (404 otherwise); the instance host keeps serving every product, so links already sent keep working.
- Instance keys (`clr_ik_`): instance admins create them (Settings, Products, Instance keys; `GET/POST /v1/instance/keys`, `POST /v1/instance/keys/:id/revoke`) with scopes `products:write`, `keys:write`, `transports:write`, `instance:read` and `people:erase`. They manage products, a product's admin keys and transports (product from `X-Claros-Product` or `?product=`), read the instance, and never authenticate ingestion or other product routes. See [API keys](docs/guide/API_KEYS.md#instance-keys).
- `DELETE /v1/instance/people/:email` erases a person (by email, ignoring case) in every product (instance admin or `people:erase`).

#### Topics and transports

- Topics and consent: products can define topics (`marketing`, `lifecycle`, `transactional`) with `GET/POST /v1/topics` and `PATCH /v1/topics/:id`, and give a flow a topic (`topic_id` on flows). A contact unsubscribed from a topic, or not opted in to an opt-in topic, does not receive its mail (suppressed with `status_reason = topic_unsubscribed`); transactional topics ignore topic unsubscribes, and the suppression list still blocks everything. Identify `traits.topics` (`{ "<slug>": true | false }`) records consent; `GET /v1/contacts/:id` lists topic statuses as `topics`. Dashboard: Settings, Topics, a topic picker in the flow editor, and topic statuses on a person's page. See [Topics and consent](docs/guide/TOPICS.md).
- Topics `mirror_only` (dashboard toggle "Mirror only"): the topic mirrors a consent kept elsewhere and no flow may send on it; config apply and the flows API refuse a flow on it.
- Unsubscribe per topic: the one-click link of a message with a marketing or lifecycle topic unsubscribes that topic only; links without a topic (all mail sent before this release, and messages without a topic) unsubscribe the whole product as before. The unsubscribe page lists the product's topics with checkboxes plus "Unsubscribe from all".
- Several transports per product with routing: `GET/POST /v1/settings/transports`, `PATCH/DELETE /v1/settings/transports/:id`, `POST /v1/settings/transports/:id/test` and `PUT /v1/settings/transport-routing` (`transactional`, `default`). Transactional-topic mail uses the transactional route, everything else the default route; without routing the oldest transport sends everything, as before. Transports gain an optional name and Reply-To; `daily_limit` applies per transport. Dashboard: Settings, Transports. See [Transports](docs/guide/TRANSPORTS.md).
- Cloudflare Email Service transport (`cloudflare`), for transactional mail only: the REST API with an account id and API token, or the Workers `send_email` binding `EMAIL`. A non-transactional message routed to it fails with `status_reason = transport_policy`, and routing refuses it as the default transport (400).
- SMTP on Cloudflare Workers uses `worker-mailer`.
- Resend sends carry `reply_to` (transport Reply-To, else the branding Reply-To) and tags `claros_tenant`, `claros_message_id` and `claros_flow`.

#### Alerts

- Operational alerts (G25), on Postgres + Node and on Workers + D1: dead-lettered jobs, job exceptions, late periodic jobs, send error rates and provider authentication errors, approved mail left unsent (no usable transport or no `UNSUBSCRIBE_SIGNING_KEY`), Resend webhook failures and LLM error rates are recorded as events (kept 30 days) and grouped into alerts. Error and critical alerts are mailed within 5 minutes, repeats at most hourly, at most 10 alert mails per hour; a daily digest goes out at 07:00 UTC. Alert mail is transactional and goes through a product's transactional route. Settings `alerts.email` (default: the oldest instance admin), `alerts.enabled` and `alerts.via_product`. `GET /v1/instance/health`, `POST /v1/instance/alerts/:fingerprint/resolve` and `/mute`, and a Settings, Health page for instance admins. See [Alerts and health](docs/guide/ALERTS.md).

#### Admin keys and config as code

- Admin API keys (G1): owners create product admin keys (`clr_ak_...`) with scopes (`config`, `suppressions`, `messages`, `contacts:read`, `contacts:delete`, `broadcasts`, `kb`) under Integrate or with `POST /v1/ingestion/keys` `{"kind": "admin", "scopes": [...]}`. Management routes accept `Authorization: Bearer clr_ak_...` for the scopes the key carries, on the key's product only; ingestion keys never reach them and admin keys never write events. Keys with the `config` scope can also list flows (`GET /v1/flows`) and pause or resume one by id or slug (`POST /v1/flows/:ref/pause`, `/resume`). See [API keys](docs/guide/API_KEYS.md).
- Config as code (G2): `PUT /v1/config` (`?dry_run=1` for the diff) applies one JSON document of flows, templates, topics, transport routing by name, settings and webhooks, upserted by slug, atomically, bumping `config_version`; `prune: true` removes unlisted items. Unknown step fields are rejected, and `settings.data_sources` entries are validated (`url`, `secret`, `secret_ref` or `secret_env`, `timeout_ms`, `signature`, `modes`, `response_shape`). The apply reports `warnings` (trigger keys a trigger type does not read, date triggers on undeclared date traits, nurture-class date schedules) without blocking. `GET /v1/config` exports the current configuration, including `mirror_only`, `batch_interval_minutes` and the settings below. `claros apply -f claros.config.json [--dry-run]` in the CLI prints the diff and the warnings. JSON Schema: `docs/reference/claros.config.schema.json`. Dashboard: Settings, Config as code downloads the product's configuration as `claros.config.json`. See [Config as code](docs/guide/CONFIG.md).
- Settings in the config document: `lifecycle` (lifecycle thresholds), `brain.assess` (`enabled`, score `threshold`), `llm_daily_token_budget` (over budget, drafts wait at `pending_generation` with `status_reason = llm_budget`, shown on the Approvals page; resets at midnight UTC), `approvals.daily_digest` (a daily waiting-approvals mail to the product's owners at 08:00 product time, through the transactional route) and webhook `batch_interval_minutes`.
- `PUT /v1/flows/:id/steps`: write a flow's plan as explicit steps (the config document's step shape, every field), for members and admin keys with the `config` scope; the plan is stored as compiled.
- Suppression API (G12): bulk `POST /v1/suppressions` `{"emails": [...], "reason": ...}`, `DELETE /v1/suppressions/:email` (complaint and hard-bounce suppressions only with `?force=1`), `GET /v1/suppressions?since=`, and `DELETE /v1/contacts/:external_id` to erase a contact with its events, memberships and messages.
- Approval actions (G20): edit a pending message (`PATCH /v1/messages/:id`, the drafted version is kept), regenerate it with an optional forced action type (`POST /v1/messages/:id/regenerate`), cancel an approved message (`/cancel`, new status `cancelled`) or send it back to review (`/unapprove`), and exclude a person (`POST /v1/contacts/:id/exclude`: suppression plus every unsent message cancelled). Messages record `approved_by`, `rejected_by` and `edited_by`. The Approvals screen gains edit, regenerate, exclude, an "Approved, not sent yet" list and keyboard shortcuts (`j`/`k`, `a`, `r`, `e`). See [Approvals](docs/guide/APPROVALS.md).
- Messages API: `context_snapshot`, `choose`, `opening_line`, `kb_entry_id` and `imported` on messages.

#### Webhooks and analytics

- Signed outbound webhooks (G5): `message.sent`, `delivered`, `opened`, `clicked`, `bounced`, `complained`, `failed`, `pending_approval` (batched per endpoint, window `batch_interval_minutes`, default 15), `contact.subscribed`, `unsubscribed`, `resubscribed`, `suppressed`, `flow.enrolled`, `flow.exited`. Events are written to an outbox with the change they report and delivered with Standard Webhooks signatures, retried with backoff (1 minute to 12 hours) and marked dead after 12 attempts. `message.failed` also fires when the recovery job gives up on a stuck message and when content generation fails permanently; `contact.subscribed` and `contact.unsubscribed` fire when an identify call's `topics` changes a topic status; `contact.suppressed` fires for the suppression API (single and bulk) and CSV suppression imports. See [Webhooks](docs/guide/WEBHOOKS.md).
- Webhooks API and dashboard page: `GET/POST /v1/webhooks`, `PATCH/DELETE /v1/webhooks/:slug`, `POST /v1/webhooks/:slug/rotate` (new signing secret, shown once) and `GET /v1/webhooks/:slug/deliveries` (latest 50), for owners and admin keys with the `config` scope. Settings, Webhooks lists endpoints and their deliveries. See [Webhooks](docs/guide/WEBHOOKS.md#managing-webhooks).
- Analytics sink (G30): product setting `analytics` sends `flow_enrolled`, `flow_exited`, `email_sent`, `email_clicked`, `email_bounced`, `email_complained`, `email_unsubscribed`, `approval_decided` and `choose_decided` keyed to the contact's `external_id`, to StatsRaven (`/ingest`) or a webhook, through the same outbox. No open events.
- UTM tagging (G6): product setting `link_tracking` adds UTM parameters and `clr_cid=<message id>` to links on the product's domains when a message is sent; never on unsubscribe or footer links, never overwriting a parameter.

#### Flows and engine

- Date triggers (G3): flow triggers `date_property` (`{"property": "trial_ends_at", "offset": "-3d"}`) and `date_schedule` (`{"anchor": "first_paid_at", "offsets": ["1d", "3d", "7d"], "repeat": "30d", "max_sends": 7}`), with `send_at_local` (contact timezone, else the product's) and `where` conditions checked at every send. Declared `settings.date_traits` are indexed on identify; a contact enrolls once per date value; a moved or removed date exits the old enrollment (`date_changed`) and cancels its unsent messages. Step condition `{"date_unchanged": true}` and step `expires_after` (unsent messages are cancelled with reason `expired`). See [Flows](docs/guide/FLOWS.md#date-triggers).
- Flow class `scheduled`: runs alongside other flows (it does not take the contact's one nurture slot) but respects frequency caps and send windows. Recommended for long date schedules. See [Flows](docs/guide/FLOWS.md#flow-classes).
- Triggers: `where` on every trigger type (lifecycle transition, segment, manual, dates, events); `trigger.event` may be a list of event names; a lifecycle transition without `from` matches any previous state; segment triggers by lifecycle state and engagement depth (`{"lifecycle_states": [...], "engagement_depths"?: [...]}`) besides a retention-grid cell.
- Manual enrollment: `POST /v1/flows/:id-or-slug/enroll` enrolls listed contacts (`external_ids`) or, page by page, every contact meeting the trigger's `where` (member session, or admin key scope `config`).
- Trait and send-history conditions (G4, G28): `{trait: {key, op, value}}`, `{history: {flow | action_type | topic, within, op}}` and `{first_contact: true | false}` on step conditions, step and plan exits, and event triggers (`{event, where: [...]}`).
- Condition combinators: `{"all": [...]}`, `{"any": [...]}` and `{"not": ...}` (up to 4 deep) on step `condition` and `exit_condition`, plan `exit_conditions` entries, trigger `where` and choose-candidate `when`; a list where one condition is expected means all. New audience leaves `{"lifecycle_state": ...}` and `{"lifecycle_state_not": ...}` in `where` and `when`. See [Conditions](docs/guide/CONFIG.md#conditions).
- Context sources (G11): `settings.data_sources` and step `context`, `on_empty`, `on_error`. Claros posts a signed (Standard Webhooks) request at render time; the data is stored on the message, shown in approvals, and usable in templates (`{{context.*}}` with Mustache sections) and by the drafting model. Data source secrets are stored encrypted.
- The `choose` step (G27): candidates with `when`, `kb_select`, `context`, `cooldown`; deterministic filters run first, the LLM picks one eligible candidate or none, and the decision (choice, eligible set, filtered-out reasons, reason) is stored on the message, shown in approvals and sent to the analytics sink as `choose_decided`. A product without an LLM cannot apply a choose step.
- Knowledge base v2 (G18, G15): entries gain `category`, `external_key`, `data`, `pinned`; step `kb_select` (`category`, `exclude_used`, `pick`, `tags_any_from_trait`) never sends an entry twice to a contact; pinned entries always reach the drafting model. `POST /v1/kb/import` (admin key scope `kb`) and `claros kb import <file> [--dry-run] [--force]` upsert by `external_key` without overwriting entries edited in Claros and never delete. Dashboard: entries show and edit `category` and `pinned`, and show `external_key` and `data` read-only. See [Knowledge base](docs/guide/KB.md).
- History import (G21): `POST /v1/import/messages` (admin key scope `messages`) and `claros import messages <file.jsonl>` store a product's earlier sends as sent, imported messages that count for caps, re-entry, history conditions, cooldowns and KB deduplication. See [Importing send history](docs/guide/IMPORT.md).
- Step persona fields: `from_name` (display name; the address stays the transport's sender), `reply_to`, `eyebrow` (a label above the body) and `preheader` (hidden inbox preview text), applied when the mail is sent; a choose candidate may set its own `eyebrow`.
- Template variables `{{event.*}}` (properties of the event that enrolled the contact, kept on the enrollment) and `{{traits.*}}` (alias of `{{contact.properties.*}}`), with Mustache sections over traits.
- Named links and checks on AI drafts (G19): `{{links.<name>}}` in templates and instructions; once a product declares `links` or tracked domains, a draft with any other URL fails with `status_reason = link_not_allowed`. `settings.brain.text_rules` accepts `{"find", "replace"}` and `{"forbid"}` rules applied after drafting (`text_rule_forbidden`), besides plain writing rules.
- Step `allowed_links` (restricts the named links and the link allowlist of that step) and `single_cta` (at most one link: drafts with more fail with `status_reason = single_cta`; the config apply refuses a fixed template with more).
- Product guidelines and language (G22): `settings.brain.guidelines` reaches the drafting and value-gate models; the product `locale` sets the drafting language and the language of the mail footer and unsubscribe pages (English and Spanish).
- AI opening line in fixed templates (G29): a `{{brain.opening}}` slot gets one drafted line (at most 240 characters), shown in approvals. Templates without it make no LLM call.
- Flow compilation: the compile prompt teaches the condition combinators, trait / history / first_contact leaves, choose steps and the product-data step fields, and lists the product's link names, data sources and KB categories.
- Dashboard flow editor: every trigger type can be created and edited after creation (date property, date schedule, several events, segment by lifecycle state and engagement depth, manual, and `where` conditions on any trigger); a plan editor for every step field (choose steps and candidates, context sources, `kb_select`, `expires_after`, from name, reply-to, eyebrow, preheader, `allowed_links`, `single_cta`) with a condition builder for `all`, `any` and `not` and a JSON mode; flow class (including `scheduled`), priority and re-entry in the flow's settings.

### Changed

- List-Unsubscribe (D18): messages whose topic kind is `transactional` no longer carry the `List-Unsubscribe` and `List-Unsubscribe-Post` headers; their footer with the postal address and unsubscribe link is unchanged. Every other message, including every message without a topic, carries them as before.
- With several transports, `PUT /v1/settings/transport` replaces the default transport only and `GET /v1/settings/transport` returns the default transport. A product with one transport sees no difference.
- First-account claim: the token is stored hashed in the new `claim_tokens` table instead of in the server's memory, and expires after 24 hours. The server still prints the claim URL at startup while no user exists and mints a new one on every restart (older unconsumed links stop working). Any API instance behind a load balancer can now serve the claim. On Workers, `/claim` is open while no user exists and uses tokens minted by `claros deploy` / `claros claim-url`.
- `GET /auth/me` reports the role and product (`tenantId`) of the product the request acts on. Without a product header this is the session's product, as before.
- New API keys get the prefixes `clr_pk_` (publishable) and `clr_sk_` (secret) instead of `cl_pub_` and `cl_live_`. Existing keys keep working.
- `GET /v1/messages` orders critical-class flows first, then oldest first, and adds the flow name and class, approval actors and the drafted version of edited messages to each message. Cursors from earlier responses keep working.
- A permanent provider failure now records the provider's error as the message's `status_reason` (`provider_error: ...`), and the drain records the sending transport on the message before the send (`transport_id`), so failed sends are attributed to their transport.
- Embedding a knowledge base entry no longer changes its `updated_at` (the embedding is derived data, not an edit).

### Fixed

- The branding Reply-To (`brand.reply_to`) is now sent as the Reply-To of mail when the transport has none. Before, it was stored but not used.

### Upgrade notes

- Docker + Postgres installs: `git pull`, then `docker compose build` and `docker compose up`. Migrations `0023` to `0029` run on boot (or with `scripts/migrate.sh` / `npm run db:migrate` when `CLAROS_MIGRATE_ON_BOOT` is off). They only add tables, nullable or defaulted columns and indexes; existing data, keys and sessions keep working. Take a backup first: there is no schema downgrade.
- New Cloudflare Workers + D1 installs: `npx claros deploy`, see [Install on Cloudflare Workers + D1](docs/install/cloudflare.md). Later upgrades: `npx claros upgrade`. Moving an existing Postgres install to D1 is not part of this release; Postgres installs stay on Postgres.
- Behaviour changes to be aware of:
  - `List-Unsubscribe` and `List-Unsubscribe-Post` are omitted only on messages whose topic kind is `transactional`. Nothing changes until you create a transactional topic and put flows on it.
  - Once a product has a `public_host`, unsubscribe links in its new mail use that host; point the host at Claros (DNS and reverse proxy on Node, `claros products set-host` on Workers) before setting it. Links already sent keep working on the instance host.
  - The branding Reply-To is now sent when the transport has none.
  - The first-account claim URL expires after 24 hours and a restart mints a new one.
  - New API keys use the `clr_` prefixes; existing `cl_` keys keep working.
  - Archived products reject ingestion with `403` and stop sending.
  - Once a product declares `links` or `link_tracking.domains`, AI drafts with other URLs fail with `link_not_allowed`. Earlier products keep their behaviour until they declare them.
- `0023_instance_layer` adds the `memberships` and `instance_settings` tables, new nullable `tenants` columns (`archived_at`, `public_host`, `locale`) and `config_version`, `users.instance_role`, and makes `api_keys.tenant_id` nullable for instance keys. It backfills one membership per existing user and makes the active owners of the oldest product instance admins.
- `0024_claim_tokens` adds the `claim_tokens` table.
- `0025_topics_transports` adds the `topics` and `contact_topics` tables, nullable `flows.topic_id`, `lifecycle_messages.topic_id`, `transport_id` and `status_reason`, and nullable `transport_configs.kind`, `name` and `reply_to`; existing transports get `kind` = their provider. Nothing else changes until topics or a second transport are configured.
- `0026_ops_alerts` adds the `ops_events` and `ops_alerts` tables. A new periodic job, `claros.alerts-digest` (daily 07:00 UTC), is scheduled on start. Installs without an alert recipient mail the oldest instance admin once a transport exists; set `alerts.enabled` to `false` to keep alerts on the Health page only.
- `0027_integration_surface` adds `api_keys.scopes`, `flows.slug` (unique per product when set), the approval columns on `lifecycle_messages` (`approved_by`, `rejected_by`, `edited_by`, `edited_at`, `original_subject`, `original_body_html`, `original_body_text`, `forced_action_type`) and the `webhook_endpoints` and `webhook_outbox` tables. A new periodic job, `claros.webhook-delivery`, runs every minute on Postgres + Node (every 5-minute tick on Workers); it does nothing until a product configures a webhook or an analytics sink.
- `0028_p5_engine` adds the `contact_dates` table, `flow_memberships.anchor_at`, the knowledge base columns (`category`, `external_key`, `data`, `pinned`, `imported_at`) and the message columns for imports, expiry, context, choose decisions and opening lines.
- `0029_p5b_readiness` adds the `tenant_daily_usage` table, `flow_memberships.trigger_properties` and `topics.mirror_only`.
- The D1 schema is in `drizzle/migrations-sqlite` (`0000` to `0009`); `claros deploy` and `claros upgrade` apply it.

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

[Unreleased]: https://github.com/claroshq/claros/compare/v0.8.6...HEAD
[0.8.6]: https://github.com/claroshq/claros/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/claroshq/claros/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/claroshq/claros/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/claroshq/claros/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/claroshq/claros/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/claroshq/claros/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/claroshq/claros/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/claroshq/claros/compare/v0.6.4...v0.7.0
[0.6.4]: https://github.com/claroshq/claros/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/claroshq/claros/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/claroshq/claros/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/claroshq/claros/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/claroshq/claros/compare/v0.5.2...v0.6.0
