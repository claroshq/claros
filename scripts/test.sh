#!/usr/bin/env bash
# scripts/test.sh - Run tests with .env loaded into the shell environment.
#
# Loads .env (when present) so database-backed tests can reach the local
# Postgres, builds the workspaces in dependency order, then runs every
# workspace's vitest suite. In CI the workflow env block provides the vars.
#
# The parser handles single-quoted, double-quoted, and unquoted values,
# comments, and blank lines. It does NOT override variables already set in the
# environment (matching standard dotenv precedence: explicit env wins over file).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blank lines and comments
    case "$line" in
      ""|\#*) continue ;;
    esac

    # Must look like KEY=VALUE
    if ! echo "$line" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*='; then
      continue
    fi

    key="${line%%=*}"
    value="${line#*=}"

    # Strip surrounding quotes (single or double)
    case "$value" in
      \'*\')
        value="${value#\'}"
        value="${value%\'}"
        ;;
      \"*\")
        value="${value#\"}"
        value="${value%\"}"
        ;;
    esac

    # Do not override variables already set in the environment.
    eval "existing_val=\${$key+x}"
    if [ -n "$existing_val" ]; then
      continue
    fi

    export "$key=$value"
  done < "$ENV_FILE"
fi

# Check that local database has all migrations applied.
# Fails fast with a clear message if behind; skips silently if no DB configured.
"$REPO_ROOT/scripts/check-migrations.sh"

# Check that database-dependent test files follow the *.db.test.ts naming convention.
# Fails immediately if a new test file requires Postgres but is not named *.db.test.ts,
# which would cause a silent failure in the release verify.sh mirror run.
"$REPO_ROOT/scripts/check-test-naming.sh"

cd "$REPO_ROOT"
npm run build --silent
exec npm test --workspaces --if-present -- "$@"
