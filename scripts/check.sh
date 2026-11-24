#!/usr/bin/env bash
# scripts/check.sh - Everything CI's `check` workflow runs, in one local command.
#
# Steps: shellcheck on scripts, build, typecheck, docs checks, test suites
# (unit + Postgres-backed). Postgres-backed tests need DATABASE_URL (loaded
# from .env by scripts/test.sh) and a migrated database.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck scripts/*.sh docker/initdb/*.sh
else
  echo "shellcheck not installed; skipping locally (CI runs it). Install: brew install shellcheck" >&2
fi

echo "==> typecheck"
npm run typecheck --silent

echo "==> docs"
bash scripts/check-docs.sh

echo "==> tests"
bash scripts/test.sh

echo "==> upgrade from v0.6.4"
if command -v psql >/dev/null 2>&1; then
  UPGRADE_ADMIN_URL="${UPGRADE_ADMIN_URL:-postgres://claros:claros@localhost:5433/postgres}" bash scripts/test-upgrade.sh
else
  echo "psql not installed; skipping locally (CI runs it). Install: brew install libpq" >&2
fi
