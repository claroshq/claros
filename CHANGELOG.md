# Changelog

All notable changes to Claros are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release has a GitHub Release with the same notes and an upgrade section.

## [Unreleased]

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
