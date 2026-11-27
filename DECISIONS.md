# Decisions

Architecture and process decisions for Claros, newest first. Each entry says what was decided, why, and what it replaces. Decisions marked "default" were taken by the implementing agent from a written recommendation and can be overridden by the maintainer.

## 2026-11-24: v1 direction

Source: the v1 handoff (maintainer's private notes), decided items D1 to D20.

**Backends and runtimes (D1, D2, D3, D8).** Claros v1 runs on Postgres (Node, Docker) or Cloudflare D1 (Workers) with the same HTTP API and behaviour. D1 is an addition, not a replacement: Postgres + Node stays first-class and backward compatible, and v0.6 installs upgrade in place. Code above a repository layer never sees a SQL dialect; Drizzle keeps twin schemas (`pg-core`, `sqlite-core`). Hono replaces Fastify on both runtimes with the same external API. Runtime seams: `JobQueue` (pg-boss / Queues), `Scheduler` (pg-boss schedules / Cron Trigger), `Transport`. Plain SQLite on Node (`node:sqlite`) is out of scope for v1.

**Capabilities (D5).** Behaviour is unified at the API level, not cut down to a common storage subset. Postgres keeps optional pgvector KB similarity and partitioned `events`; D1 uses FTS5 and a plain `events` table with a daily rollup and retention. `GET /v1/capabilities` reports the differences.

**Dependencies (D6).** Approved: `hono`, `@hono/node-server`, `wrangler` (dev; runtime dep of the CLI), `@cloudflare/vitest-pool-workers` (dev), `@hono/zod-openapi` (D11), `worker-mailer` (SMTP on Workers), and in the dashboard the CodeMirror 6 editor packages `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`, `@lezer/html`, `@lezer/highlight` (MIT, approved by the maintainer 2026-11-25 for the email body editor; loaded lazily). Anything else needs the maintainer.

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

## 2026-11-25: Email templates and the template studio

Requested by the maintainer: a template library with built-in narrow and wide templates, and a chat that edits a template ("vibe coding"), restricted to that job and aware of mail client support. Defaults taken while implementing (the maintainer may override):

- **Name.** The dashboard says "Templates"; the API is `/v1/layouts` and the table `email_layouts`, because `/v1/templates` (business-model templates) and `/v1/email-templates` (v0.6 content templates) already exist and stay as they are.
- **A template is the whole document**, HTML with placeholders (`{{body}}`, `{{compliance_footer}}`, `{{logo}}`, ...), filled in one pass at send time. `{{body}}` and `{{compliance_footer}}` are required exactly once, so no template can drop the unsubscribe link and postal address. Built-in templates are code; `classic` and `wide` are the v0.8.7 narrow and wide shells, pinned byte for byte.
- **Selection.** `settings.brand.template` (built-in key or custom id) wins over `brand.layout`; unset or naming a deleted template, `brand.layout` decides as before. One template per product at first; superseded the same day by per-flow templates (below).
- **Third LLM place.** The studio calls the product's chat LLM at authoring time only (operator-initiated, dashboard), never on the send path. Architecture rule 2 in CLAUDE.md now names three places. Tokens are counted toward the daily LLM usage but the studio does not wait for the budget.
- **Scope and client knowledge** are enforced in the prompt (off-topic answers get one sentence, breaking changes are proposed, not applied) and backed by deterministic checks in `@claros/core` (`validateLayoutSource` blocks saving, `lintLayoutSource` lists client issues). The model's template is validated before the operator sees it, with one repair round. Output is tagged text, not JSON.
- **Stateless studio.** The working copy and chat live in the browser (sessionStorage per product and template); the server stores only saved templates. No chat history table.

## 2026-11-25: Email template per flow

Requested by the maintainer right after the template library shipped ("send this flow with that template"). Defaults taken:

- **Per flow, not per step.** New nullable column `flows.email_template` (built-in key or `email_layouts` id), set in the flow editor's Delivery settings, on `POST/PATCH /v1/flows` and in config documents (`email_template`). Per step can extend it later.
- **Resolution at send time** (`resolveMessageLayout` in core): the flow's template when it names a built-in or an existing stored template, else the product's `brand.template`, else `brand.layout`. A flow pointing at a deleted template therefore falls back to the product default, never to an error.
- **Deleting** a custom template that a non-archived flow uses answers 409 with the flow names; the Templates list reports `flow_count`.
- Config documents do not check that a custom template id exists (they hold no template list); an unknown id falls back at send time like a deleted one. Built-in keys are checked.


## 2026-11-27: `churned` renamed `gone_quiet`

Found on a live instance: a contact who pays every month showed as `churned`, because the state means "no product activity for `churned_days`" (payment events were not in `engagement_events`) and says nothing about billing. "Churned" reads as "left and stopped paying", so the maintainer chose to rename the state in the API, not only in the dashboard. Decisions:

- **Name.** `gone_quiet`, threshold `gone_quiet_days`. It says what the engine observes (no activity) without a claim about money. The plan or payment status stays a trait (`payment_status`).
- **Expand-contract (architecture rule 6).** Step 1 (this release): `gone_quiet` is accepted wherever a state is input (flow trigger `from`/`to`, segment `lifecycle_states`, `lifecycle_state`, `lifecycle_state_not`, `lifecycle_state_change` exits, `GET /v1/contacts?lifecycle_state=`) and means the stored `churned` (`storedLifecycleState` in core, applied where states are compared, so stored flows may hold either name). `gone_quiet_days` is accepted and wins over `churned_days`; giving both with different values is a config error. Stored and returned values stay `churned`; the dashboard shows `gone_quiet` and keeps sending `churned`. Step 2 (next minor): the API returns `gone_quiet` wherever it returns a state, and `churned` stays accepted as input with no removal date.
- **No data migration.** The database keeps storing `churned`; the API translates at its boundary (input `gone_quiet` -> `churned`, output `churned` -> `gone_quiet`), like the `email_layouts` table behind "Templates". Rewriting `contacts` and `lifecycle_transitions` would not be additive: `claros upgrade` applies D1 migrations before deploying and rolls back only the Worker when the deploy fails, and the previous release throws on a state it does not know, so a rollback would break ingest for those contacts. The database is not an API contract.
- **Not done:** making the state billing-aware (Claros does not know billing beyond the `payment_status` trait, and a paying customer who stopped using the product is exactly the contact a win-back should reach), or adding payment events to `engagement_events` by default.

## 2026-11-27: MCP server

Requested by the maintainer so an operator can work a product's approval queue from Claude (Claude Code, Claude Desktop, later claude.ai) without the dashboard. Decisions:

- **Endpoint.** One `POST /v1/mcp`, Streamable HTTP, stateless, one JSON response per request; no event streams or sessions (`GET`/`DELETE` answer 405). Served by `packages/api`, so it runs unchanged on Node + Postgres and Workers + D1.
- **No SDK (D6 unchanged).** A hand-written JSON-RPC handler (`initialize`, `ping`, `tools/list`, `tools/call`, about 300 lines) instead of `@modelcontextprotocol/sdk`: the SDK (1.x) brings 17 runtime dependencies (Express, ajv, jose, cors, ...) for features Claros does not use, and its 2.x server needs zod 4. Tool input schemas use the `zod/v4` subpath of the installed zod 3.25 for its JSON Schema export (the api package's zod range moved to `^3.25.0`); the rest of the code stays on zod 3. Conformance is checked with the Workers e2e test, `scripts/mcp-smoke.mjs` and, by hand, the MCP Inspector.
- **Auth.** Product admin keys only (`Authorization: Bearer clr_ak_...`); the product comes from the key (rule 5). Sessions, ingestion keys and instance keys answer 401, so a browser page cannot drive it with an operator's cookie; a cross-origin `Origin` answers 403.
- **Scopes.** No new scopes: each tool maps onto an existing one (`messages`, `contacts:read`, `config`). `tools/list` filters by scope and `tools/call` checks again (JSON-RPC error -32003).
- **One implementation.** The route handlers' transition logic moved to `packages/api/src/services` (typed outcomes: ok, already, conflict with the current status, not found); the routes and the tools both call it. Three store reads were added on both backends: one message by id, open message counts per flow and status, an exact email lookup.
- **Tool set (v1).** Reads: `queue_summary`, `list_pending_approvals`, `get_message`, `get_contact`, `get_contact_timeline`, `list_flows`. Writes: approve and reject (bulk, per-id outcome), edit, regenerate, cancel, unapprove, `exclude_contact`, pause and resume flows. Not exposed: sending or test sends, flow, prompt, template, transport and config changes, ingest and import, deletes and erasure, key management, instance-key actions.
- **Results.** A message that moved on is a tool result (`outcome: conflict` with the status), not a protocol error. Bulk tools report mixed outcomes as a normal result; single-message conflicts and invalid input are `isError` results. `queue_summary` counts `value_gated` and failed generations over the last 7 days (both are final statuses that would otherwise grow without bound).
- **Actors.** Approve, reject, cancel and edit record `api_key:<key id>` as before. Regenerate, unapprove, exclude and pause/resume have no actor column; the MCP log line (tool, product, key id, outcome, duration, never arguments) is their record for now. Adding columns is left for later.
- **Later.** OAuth 2.1 for claude.ai custom connectors with per-person attribution, a retention grid tool, notifying a connected client when drafts wait.

## 2026-11-27: Revise a draft with AI

The maintainer found the Approvals action row unusable for what reviewers actually do: tell the AI what is wrong with a draft ("there is no /mcp page") and get a better one. The only input there was the force-action-type field of regenerate. Defaults taken:

- **Through the content worker, not a new LLM call in the API.** Revise is regenerate with an `instruction`. The worker already assembles the full drafting context (context sources, knowledge base, named links, writing rules, language) and runs the post-draft checks (text rules, link allowlist, single CTA). A second, lighter path in the API would drift from it. The cost is latency: the revised draft arrives after the queue job runs, not inside the request; the dashboard follows it with `GET /v1/messages/:id`.
- **The previous draft is revised, not replaced.** The row keeps its subject and body; the claim returns them with the instruction, and the instruction block (previous subject, body, feedback) is appended to the step's brain instruction after budget truncation and variable rendering, so neither changes it.
- **Decide and the value gate are skipped** on a revision, as for a forced action: a reviewer asked for it and reviews the result. A choose step keeps the action it picked.
- **The thread is stored** (`lifecycle_messages.revisions`, append-only JSON with actor and time; `revision_request` while one is being applied), so it survives a reload and records who asked for what. Revise had no actor record before; regenerate without instruction still has none.
- **Template steps are re-rendered, not revised**; the reasoning says so. Edit the draft or the template instead.
