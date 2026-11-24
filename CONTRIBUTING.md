# Contributing to Claros

Claros is MIT-licensed and developed in the open in this repository.

## Issues first

The most useful contribution is a clear issue:

- **Bug report:** what you expected, what happened, steps to reproduce, and your environment (OS, Docker version, Postgres version, how you deployed, Claros version from `GET /version`).
- **Feature request:** the problem you are trying to solve, not only the solution you have in mind.
- **Question:** use [GitHub Discussions](https://github.com/claroshq/claros/discussions).

For security issues, do not open a public issue. See [SECURITY.md](./SECURITY.md).

## Pull requests

Pull requests are welcome. Every pull request runs the `check` workflow. Be aware that Claros has a small core team and a specific direction: merges are rare, and an issue that describes the problem is often more useful than a patch. For anything larger than a small fix, open an issue first so we can agree on the approach before you spend time on it.

A pull request is ready for review when:

- `npm run check` passes locally (see below);
- behaviour changes have tests, and no existing assertion was weakened;
- user-facing changes update the docs in `docs/` and add an entry under `## [Unreleased]` in [CHANGELOG.md](./CHANGELOG.md);
- the HTTP API stays backward compatible (see "Compatibility" below).

## Running the checks locally

Requirements: Node.js 22+ (with npm), Docker (for the local Postgres).

```bash
npm install
docker compose up -d postgres        # Postgres 16 + pgvector on localhost:5433
cp .env.example .env                 # then fill in ENCRYPTION_KEY and UNSUBSCRIBE_SIGNING_KEY
npm run db:migrate -- --yes          # apply migrations to the local database
npm run check                        # build, typecheck, tests (unit + Postgres-backed), shellcheck
```

`npm test` runs the test suites only. Test files that need Postgres are named `*.db.test.ts`.

## Compatibility

Claros has users running it in production. Changes follow these rules:

- The HTTP API, the ingest contract and the environment variables of the Docker install stay backward compatible within a major version.
- Removing or changing something user-visible needs a deprecation in a release before it is removed, with a note in CHANGELOG.md.
- Database migrations are expand-contract: a destructive schema change never ships in the same release as the code that stops using the old shape.

## Style

- TypeScript, Zod at boundaries, tests with Vitest.
- No em dashes in code, comments, docs or UI copy. Use regular hyphens.
- Commit messages and all text in English.
