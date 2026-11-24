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
