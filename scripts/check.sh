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
