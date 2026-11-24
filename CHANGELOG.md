# Changelog

All notable changes to Claros are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release has a GitHub Release with the same notes and an upgrade section.

## [Unreleased]

### Changed

- The repository is now the single source of Claros development. Earlier releases were published here from a separate repository; the history and tags of this repository are kept.
- Contribution model: pull requests are now accepted and run the `check` workflow. See CONTRIBUTING.md.
- Development tooling moved from pnpm + turbo to npm workspaces (`npm install`, `npm run build`, `npm test`, `npm run check`). The Docker image and `docker compose` commands are unchanged for users.
- The guides moved from `guide/` to `docs/guide/`.
- `CLAROS_EDITION` is no longer read. Claros has one open-source edition; `/health`, `/version` and `/v1/diagnostics` still report `"edition": "community"` for compatibility.
- `CLAROS_SERVE_DASHBOARD` now defaults to `true` in every case (it was already `true` for every open-source install).

### Removed

- References to a hosted Cloud edition. There is no hosted Claros service.

### Upgrade notes

- Docker installs: pull, then `docker compose build` and `docker compose up`. If you ran `docker compose run --rm install` on an earlier version, run it again once so the mounted `node_modules` are reinstalled with npm.
- From source: delete `node_modules` and `pnpm-lock.yaml` leftovers, then `npm install`.

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

[Unreleased]: https://github.com/claroshq/claros/compare/v0.6.4...HEAD
[0.6.4]: https://github.com/claroshq/claros/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/claroshq/claros/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/claroshq/claros/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/claroshq/claros/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/claroshq/claros/compare/v0.5.2...v0.6.0
