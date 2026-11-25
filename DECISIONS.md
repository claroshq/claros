# Decisions

Architecture and process decisions for Claros, newest first. Each entry says what was decided, why, and what it replaces. Decisions marked "default" were taken by the implementing agent from a written recommendation and can be overridden by the maintainer.

## 2026-11-24: v1 direction

Source: the v1 handoff (maintainer's private notes), decided items D1 to D20.

**Backends and runtimes (D1, D2, D3, D8).** Claros v1 runs on Postgres (Node, Docker) or Cloudflare D1 (Workers) with the same HTTP API and behaviour. D1 is an addition, not a replacement: Postgres + Node stays first-class and backward compatible, and v0.6 installs upgrade in place. Code above a repository layer never sees a SQL dialect; Drizzle keeps twin schemas (`pg-core`, `sqlite-core`). Hono replaces Fastify on both runtimes with the same external API. Runtime seams: `JobQueue` (pg-boss / Queues), `Scheduler` (pg-boss schedules / Cron Trigger), `Transport`. Plain SQLite on Node (`node:sqlite`) is out of scope for v1.

**Capabilities (D5).** Behaviour is unified at the API level, not cut down to a common storage subset. Postgres keeps optional pgvector KB similarity and partitioned `events`; D1 uses FTS5 and a plain `events` table with a daily rollup and retention. `GET /v1/capabilities` reports the differences.

**Dependencies (D6).** Approved: `hono`, `@hono/node-server`, `wrangler` (dev; runtime dep of the CLI), `@cloudflare/vitest-pool-workers` (dev), `@hono/zod-openapi` (D11), `worker-mailer` (SMTP on Workers). Anything else needs the maintainer.

**Upgrades (D7).** v0.6 to v1 on Postgres is a normal in-place migration, tested from a v0.6.4 dump. `claros import-postgres` is an optional Postgres to D1 move tool.

**Multi-product instances (D9).** One instance serves many products. Code keeps the name `tenant`; user-facing text says "product".

**CI and releases (D10, D20).** `check` runs on every pull request and push; `deploy` is manual only; `release` builds artifacts on tags, publishing stays manual. SemVer 2.0 (`vX.Y.Z`, pre-releases `-rc.N`), Keep a Changelog, a GitHub Release with upgrade notes per tag, Docker tags `X.Y.Z`, `X.Y`, `latest`, deprecation one release before removal. Release line: v0.7 (Hono, groundwork; shipped 2026-11-25), v0.8 (repository layer + D1 + multi-product), v1.0. The repository layer moved from v0.7 to v0.8 so the compatible Hono move could ship on its own.

**Repository (D4, D13).** `claroshq/claros` is the single repository, with its existing history and tags. The new tree lands as normal commits on top of v0.6.4; no force-push. The previous private development repository is archived and its history is not published.

**Docs (D17).** Public source of truth: `docs/architecture.md`, `docs/install/postgres.md`, `docs/install/cloudflare.md`, `CHANGELOG.md`.

**Transports (D16).** `resend | cloudflare | smtp` behind one `Transport` interface. Each product brings its own credentials; Claros is plan-agnostic and only enforces the per-transport `daily_limit` the operator sets. Cloudflare Email Service is first-class but transactional-only by a hard guard (default deny), because its terms do not allow marketing mail.

**List-Unsubscribe (D18).** RFC 8058 headers on every non-transactional message, omitted on topic kind `transactional`. This is a behaviour change against v0.6 and is recorded in the CHANGELOG of the release that ships it.

**LLM choice step (D19).** New step type `choose`: the flow declares candidates, deterministic filters (cooldowns, history, throttle, consent, conditions, KB availability) run first, the LLM picks one eligible candidate or `none`, the answer is validated, and the choice and reason are shown in approvals.

**Contribution model.** Default (maintainer may override): pull requests are accepted and run `check`; CONTRIBUTING says merges are rare and issues are preferred. Replaces the auto-close workflow.

**Package manager.** Default: npm workspaces; pnpm and turbo removed.

## Superseded

- "Private monorepo + public mirror" and the Cloud edition: removed. There is no hosted Claros service.
- "Iron Rule 3: no Workers assumptions in core, Cloud on Containers": replaced by the runtime seams above.
- "D1 disqualified, Neon stays": reversed; D1 is an additional backend.

## 2026-11-24: Additions from the first product integration

Gaps found while preparing the first product's configuration, accepted as general features:

- **G28 Send-history conditions** (P4, with trait conditions): step and flow conditions on what a contact already received, `{history: {flow | action_type | topic, within, op: none | any | count_lt}}`, plus a built-in `first_contact`.
- **G29 AI opening line in a fixed template** (P5): template slot `{{brain.opening}}`, drafted with a length cap and shown in approvals.
- **G30 Analytics sink** (P4, on the outbound webhook outbox): per-product `analytics: {sink: "statsraven" | "webhook", ...}` emitting flow and email events keyed to the product's user id; queued, retried, never blocks sending; no open events.
- Extensions: `kb_select.tags_any_from_trait` (G18), per-step sender identity and eyebrow label (G13), step `expires_after`, product `brain.text_rules` applied after drafting (G19), history import resolving contacts by email (G21), trait-audience one-off sends through broadcasts (G9).

## 2026-11-25: SQLite schema conventions

SQLite / D1 stores timestamps as integer milliseconds (Drizzle `timestamp_ms`) rather than ISO-8601 text as first proposed: values round-trip as `Date` on both backends, comparisons stay numeric and index-friendly, and the Store interfaces need no conversion. JSON columns are text, ids are text UUIDs generated in code, the knowledge base uses FTS5. The two schemas are kept in step by a parity test.

## 2026-11-25: Multi-product instance layer (expand step)

Defaults taken while implementing the instance layer; the maintainer may override:

- The user's home product (`users.tenant_id`) keeps v0.6 semantics: `users.role` decides access there. Other products need a `memberships` row. Writers keep the home product's membership in step.
- One user row per person: inviting an email that belongs to an active user of another product adds a membership. Removing a member from a non-home product deletes the membership and that product's sessions only.
- Instance admins act as owner in every product. The migration makes the active owners of the oldest product instance admins.
- The request's product comes from `X-Claros-Product`, then `?product=`, then the session's product. Archived products are read-only (writes answer 409); workers keep running for them until a later release stops ingestion and sending.
- Product slugs: 2 to 63 characters of `[a-z0-9-]`, fixed after creation. Instance settings keys: `^[a-z0-9][a-z0-9._-]{0,63}$`.
- Admin and instance API keys can be stored but do not authenticate ingestion; their own authentication comes with the management API (P4).

## 2026-11-25: Engine features for real products (P5, defaults)

Defaults taken while implementing G3, G11, G15, G18, G19, G21, G22, G27 and G29; the maintainer may override:

- **Date triggers.** A contact enrolls when a slot is due (not ahead of time), once per (flow, contact, anchor value) by a partial unique index on `flow_memberships.anchor_at`; re-entry policies do not apply to date flows. Slots older than 24 hours are never sent. A moved or removed date exits the enrollment (`date_changed`) and cancels its unsent messages. A schedule slot uses the plan step with the greatest order not above the slot number.
- **Data source secrets.** `secret` is write-only and stored encrypted inside `settings.data_sources` (`secret_enc`); `secret_ref` (alias `secret_env`) names an environment variable or Worker secret. A source without a usable secret fails closed. `on_empty` defaults to `send`, `on_error` to `defer` (retried by reap).
- **Link allowlist.** Active only once a product declares `links` or `link_tracking.domains` (earlier products keep their behaviour). URLs returned by a context source are allowed.
- **KB import edits.** "Untouched since import" is `updated_at <= imported_at`; embedding writes no longer bump `updated_at`, and a re-embed keeps an untouched entry untouched. Entries without tags pass `tags_any_from_trait`. `best_match` is word overlap (the same on both backends).
- **Choose filters.** Consent and throttle are checked flow-wide before per-candidate cooldown, `when`, KB availability and context. A forced action that is not a declared candidate records `none`.
- **History import.** Each imported message gets its own completed membership (exit reason `imported`) so re-entry and step history see it; contacts are not created by the import.

## 2026-11-25: First-product readiness (P5b, defaults)

Defaults taken while implementing P5b; the maintainer may override:

- **Combinators.** `all`, `any`, `not`, nested at most 4 deep, at most 20 entries per list; a list where one condition is expected means `all`. Plan `exit_conditions` stays an any-list. Audience conditions (`where`, `when`) gain `lifecycle_state` / `lifecycle_state_not` leaves; `event_since_step` and `date_unchanged` stay step-only.
- **Manual triggers** enroll through `POST /v1/flows/:ref/enroll` (listed external ids, or the trigger's `where` audience one page per call), synchronously, with the normal guards. No background job.
- **`{{event.*}}`** reads the enrolling event's properties, stored on the membership (`trigger_properties`) when the JSON is at most 16 KB (larger: not stored, the variables render empty).
- **Persona fields** are read from the flow's current plan at send time (not stored on the message), so editing a step changes mail still waiting to be sent.
- **`allowed_links`** narrows both what the model is told and the allowlist: only the named links (and context URLs) pass, tracked-domain URLs outside them do not.
- **LLM budget** counts every LLM call's tokens per product and UTC day (compile included); only content generation waits for it. A message that waits goes back to `pending_generation` with `status_reason = llm_budget`.
- **Value gate threshold** asks the gate for a 1-10 score; a draft that passes with a score below the threshold is `value_gated`. A gate answer without a score keeps its verdict.
- **Approvals digest** runs on the content tick, from 08:00 local (product timezone), to owners (memberships with role owner), only when something waits; a day is claimed once (`tenant_daily_usage.digest_sent_at`) before sending.
- **Config warnings** do not block an apply.
- **Events on D1**: reap give-ups and identify topic changes write their outbox rows right after the state change (no interactive transaction); a crash in between can lose the event, never the change.

## 2026-11-25: Embedding provider

Found on a D1 instance with Anthropic as the LLM provider: every knowledge base entry ended `embed failed` with Anthropic's `404 not_found_error`. The embedding client reused the chat config for every provider and defaulted to `text-embedding-3-small`, which Anthropic does not serve (it has no embeddings API). Decisions:

- **Separate provider.** Embeddings get their own table, `embedding_configs` (same shape as `llm_configs`, one active row per product), and `GET/PUT/DELETE /v1/settings/embeddings`. Providers: `openai` and `custom` (any OpenAI-compatible `/embeddings`). Voyage AI, which Anthropic recommends, is not offered: its models return 256, 512, 1024 or 2048 dimensions, not the 1536 of the Postgres column.
- **Verified at save time.** One embedding call must return 1536 components. `dimensions: 1536` is sent first (models that can shorten their vectors need it); an endpoint that answers 400 or 422 to it is retried once without, and the working variant is stored.
- **Resolution order** (worker and API alike): `embedding_configs`, else the chat `llm_configs` row when it can serve embeddings (an explicit `embedding_model`, or a provider other than `anthropic` and `ollama`), else none. Installs that embed with their OpenAI chat key keep working unchanged; only configurations that could never embed stop trying.
- **No provider is not an error.** The embed job marks the entry `embedding_status = 'skipped'` (no vector, no job queued). `kb_context` falls back to word matching: entries sharing at least 2 non-stop words with the query, most shared first, ties to the oldest, over at most 500 active entries, the same on both backends. Both numbers are unvalidated starting values. `kb_ref` no longer needs a vector. Pinned entries and `kb_select` never did.
- **Model changes re-embed.** When saving or removing the provider changes the effective base URL, model or dimensions, the product's stored vectors are dropped (`skipped`) and the first re-embed batch is enqueued; `POST /v1/kb/re-embed` takes the rest. A change of the legacy `llm_configs.embedding_model` is not detected.
- **D1 does semantic search.** D5 planned FTS5 on D1; the shipped D1 store computes cosine similarity in JS over the stored vectors instead, and the FTS5 index (`kb_fts`) is kept in sync but not read. `GET /v1/capabilities` therefore reports `kb.semantic: true` on both backends (it said `false` on D1), and the docs say so.

## 2026-11-25: Person page actions and notes

Asked for from the People page: delete a person, add notes, change free/paid, add tags, and see the mail that was sent rather than the template. Decisions:

- **Delete and exclude in the dashboard** use the existing routes (`DELETE /v1/contacts/:id`, owner; `POST /v1/contacts/:id/exclude`, member). Delete sits on the person page only, not as a row action in the list, and asks for the person's email (or user id when there is none) to be typed.
- **Notes** are a new table, `contact_notes` (author without a foreign key, so a note outlives a removed member). They are for the team only: the engine does not read them, they are not in the LLM context and they send no webhook. Member session only, no admin key scope. Erased with the contact.
- **Plan (free/paid) is not editable in the dashboard.** `payment_status` is written by the product's identify calls (`plan` or `payment_status` trait) and flows trigger on it; a dashboard edit would be overwritten silently by the next identify. The person page shows the value and says where it comes from. A manual override would need its own field and precedence rules; not built.
- **No tags.** Segments and conditions read `properties`, which the product sends. Manual tags would either do nothing in flows or open the same two-writers problem as the plan. Notes cover hand-written context.
- **Sent mail over template.** The timeline's message row links to the Sent Mail detail (the stored body as sent). That page links to the flow step and, when the step renders a template, to the template's current version in the flow editor. `template_ref` is read from the flow's current plan, so after a plan edit it names the template the step uses now.
