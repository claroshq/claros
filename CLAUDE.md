# CLAUDE.md

Claros: open-source (MIT) lifecycle email engine for SaaS. Prompt-defined flows compiled by an LLM into deterministic plans, AI-drafted content behind a human approval queue, Segment-compatible ingestion. This repository is the single source of the product, its docs and its releases. Users run it in production; treat every change as one that ships to them.

## Source of truth

1. `DECISIONS.md`: architecture and process decisions (v1 direction: Postgres + Node stays, Cloudflare D1 + Workers is added, multi-product instances, transports, release rules).
2. `docs/architecture.md`: components, install options, capability matrix. Public; keep it true for the current release.
3. `CHANGELOG.md`: what changed per release. Every user-visible change adds an entry under `## [Unreleased]`.
4. `docs/guide/*`: user documentation. `docs/BRAND.md`: brand identity, color tokens, typography, UI rules.
5. This file: working rules.

If code and docs diverge, say so before writing code. Do not silently "fix" either side.

## Stack

TypeScript (Node 22+) · npm workspaces · Hono (HTTP, on `@hono/node-server`) · Postgres 16 + pgvector · Drizzle ORM · pg-boss · Zod at all boundaries · Vitest · Vite + React dashboard · one Docker image with `--role=all|api|worker|scheduler`.

HTTP conventions (packages/api/src/http): dashboard routes use `RoleRouter` (every route declares its minimum role), bodies are parsed per route with v0.6 rules, schema-validated bodies use `validatedBody` + `validateBody`; Hono matches routes in registration order, so register static paths before overlapping param paths. In progress (see DECISIONS.md): a repository layer with twin Drizzle schemas (pg + sqlite) and an `apps/worker` Cloudflare Workers runtime on D1. Until each piece lands, the Postgres + Node path is the only released one.

New dependencies: only the ones approved in DECISIONS.md (D6). Anything else needs the maintainer.

## Architecture rules

1. **Roles communicate only through the database and the job queue.** No in-memory coupling across api / worker / scheduler.
2. **The LLM runs in exactly two places:** flow compile time and content draft time (plus the planned `choose` step, which picks among deterministically filtered candidates). Never in timing, targeting or the send path.
3. **`packages/*` stay runtime-agnostic.** No Cloudflare (`cloudflare:*`) imports outside the Workers adapters and `apps/worker`; no `pg`/`pg-boss` imports outside the Postgres adapters and `apps/server`. Above the repository layer, code never sees a SQL dialect.
4. **`packages/core` is pure logic, no I/O.** Dependency direction: core <- adapters <- api; worker <- core, adapters, brain-oss; scheduler <- worker; server <- api, worker, scheduler.
5. **Multi-tenancy:** every product-owned table has `tenant_id`, every query is tenant-scoped, every index on such a table leads with `tenant_id`. Key-authenticated requests take the tenant from the key only. No exceptions, including admin and test helpers.
6. **Backward compatibility:** the v0.6 HTTP API, ingest contract, Docker env vars and Postgres data upgrade in place. Removing or changing anything user-visible needs a deprecation in an earlier release and a CHANGELOG entry.

## Engine invariants (bugs if violated)

- Message state transitions use atomic CAS (`WHERE status = expected`). Feedback is advance-only (sent -> opened -> clicked, never backward).
- Flow concurrency is class-based: at most one active nurture-class flow per contact; critical-class flows are always concurrent.
- Re-entry: per-flow `reentry_policy` (once | cooldown | every_time), enforced by a partial unique index on active memberships only.
- Every flow step has `window_policy`: `immediate` bypasses the send window; `respect_window` does not. Critical bypasses throttle, never fairness.
- Drain is per-tenant round-robin with per-tenant sub-batch caps. A big tenant must never starve a small tenant's dunning.
- `contacts.email` is nullable; uniqueness via partial index. Email conflict (email owned by another external_id) -> reject the update, keep the event, surface it to the admin. No silent merges.
- Suppression is checked before everything else at send time.
- Every outgoing email carries the compliant footer and List-Unsubscribe + List-Unsubscribe-Post (RFC 8058) headers, including test sends to real addresses. The only exception (D18, unreleased): messages whose topic kind is `transactional` carry no List-Unsubscribe headers (footer kept).
- A `cloudflare` transport sends only messages whose topic kind is `transactional` (D16 hard guard, default deny): enforced in the drain right before send and when saving routing.
- Embeddings on Postgres: OpenAI-compatible endpoint, `vector(1536)`.
- Postgres `events` is partitioned by `received_at` (monthly range, no DEFAULT partition). The real primary key is `(id, received_at)`. Never query events by `id` without an additional filter (tenant_id, contact_id, or a received_at range).

## Commands

```bash
npm install                        # lockfile: npm 10 (package.json packageManager); update it with `npx npm@10 install`
docker compose up -d postgres      # local Postgres on localhost:5433
npm run db:migrate -- --yes        # apply migrations to DATABASE_URL (local)
npm run dev                        # role=all, watch mode
npm run build                      # all workspaces, dependency order
npm test                           # scripts/test.sh: loads .env, checks migrations, builds, runs every vitest suite
npm run check                      # shellcheck + typecheck + docs check + tests (what CI runs)
npm run db:generate                # new migration after a schema change
docker compose up                  # the self-host path
```

Schema changes always go through migrations (`npm run db:generate`, then `npm run db:migrate`), never raw psql. Test files that need Postgres are named `*.db.test.ts` (`scripts/check-test-naming.sh` enforces it). Shell scripts must be shellcheck-clean.

The self-host quickstart (`docker compose run --rm install`, `docker compose up`, a claim URL, login with no transport configured) must keep working in every change.

## Release and deploy

- CI: `.github/workflows/check.yml` runs on every pull request and push to `main`. Nothing deploys on push.
- Releases follow SemVer 2.0 and Keep a Changelog. A tag `vX.Y.Z` builds a draft GitHub Release; publishing (npm, container registry) is a manual maintainer step.
- Agents may run builds, tests, local Docker, and `wrangler dev`. Agents never run migrations against a non-local database. `PRODUCTION_DATABASE_URL` and anything remote are off limits unless the maintainer asks for that specific action in the current session.

## Working style

- All code, comments, commit messages, SQL and docs are in English.
- Investigate before implementing; report findings for anything non-trivial.
- Keep scope small. No speculative abstractions.
- Zero fabrication: no invented numbers, benchmarks, users or claims. If you do not know, check.
- Constraint violation = immediate stop: if something forbidden happened (a remote database touched, a command that should not have run), stop and report it in the same turn, plainly and completely.
- Red tests = task incomplete. "Pre-existing" and "unrelated" are conclusions that need evidence. A task is not done while `npm run check` is red.
- Migrations are expand-contract: a destructive schema change never ships in the same release as the code that stops needing the old shape.
- Never reproduce secrets or credentials in output, diffs, examples or logs.
- No em dashes anywhere (code comments, docs, UI copy); use regular hyphens.
- Never use one-sided borders or edge indicator bars in the UI (see docs/BRAND.md).
- Update `.env.example` in the same commit as any new env var. Never commit secrets; transport credentials are encrypted at rest.
