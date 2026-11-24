#!/usr/bin/env bash
# scripts/check-migrations.sh - Verify local databases have all migrations applied.
#
# Compares the number of applied migrations (in drizzle.__drizzle_migrations) against
# the number of entries in drizzle/migrations/meta/_journal.json. Fails with a clear
# message if any database is behind.
#
# Checks:
#   - DATABASE_URL (main development database)
#   - SEED_TEST_DATABASE_URL (seed test database, when set)
#
# Usage:
#   scripts/check-migrations.sh          # uses env vars from environment
#   DATABASE_URL=... scripts/check-migrations.sh
#
# Exit codes:
#   0 - all databases are up to date (or URLs unset / DBs unreachable, silent skip)
#   1 - at least one database is behind; message printed to stderr
#
# Design: this script is called by test.sh before running tests. It can also be
# wired into `npm run dev` or any other entry point that requires an up-to-date schema.
# It intentionally skips silently when a URL is unset (unit-test-only mode)
# or the database is unreachable (e.g. Docker not running).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOURNAL_FILE="$REPO_ROOT/drizzle/migrations/meta/_journal.json"

# Skip silently if journal file does not exist (fresh clone before first generate)
if [ ! -f "$JOURNAL_FILE" ]; then
  exit 0
fi

# Count expected migrations from the filesystem journal
if command -v jq &>/dev/null; then
  EXPECTED=$(jq '.entries | length' "$JOURNAL_FILE")
else
  # Fallback: count "idx" keys (one per migration entry)
  EXPECTED=$(grep -c '"idx"' "$JOURNAL_FILE")
fi

# check_db <URL> <LABEL>
# Returns 0 if OK or unreachable (silent skip), returns 1 if behind.
check_db() {
  local url="$1"
  local label="$2"

  # Skip silently if URL is empty
  if [ -z "$url" ]; then
    return 0
  fi

  # Query applied migration count. If connection fails, skip silently.
  local applied
  applied=$(psql "$url" -tAc "SELECT count(*)::int FROM drizzle.__drizzle_migrations" 2>/dev/null) || return 0

  # If we got a non-numeric result, skip (schema not initialized yet)
  if ! [[ "$applied" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  if [ "$applied" -lt "$EXPECTED" ]; then
    local behind=$((EXPECTED - applied))
    echo "" >&2
    echo "ERROR: ${label} is ${behind} migration(s) behind." >&2
    echo "" >&2
    echo "  Applied: ${applied}    Expected: ${EXPECTED}" >&2
    echo "" >&2
    echo "  Run:" >&2
    echo "    DATABASE_URL='${url}' npm run db:migrate" >&2
    echo "" >&2
    echo "  Or apply manually:" >&2
    for file in "$REPO_ROOT"/drizzle/migrations/*.sql; do
      local basename_file
      basename_file=$(basename "$file" .sql)
      local idx
      idx=$(echo "$basename_file" | grep -oE '^[0-9]+' | sed 's/^0*//' )
      if [ "${idx:-0}" -ge "$applied" ]; then
        echo "    psql '${url}' -f $file" >&2
      fi
    done
    echo "" >&2
    echo "  Tests will fail with opaque errors until the schema is current." >&2
    echo "" >&2
    return 1
  fi

  return 0
}

EXIT_CODE=0

check_db "${DATABASE_URL:-}" "Local database (DATABASE_URL)" || EXIT_CODE=1
check_db "${SEED_TEST_DATABASE_URL:-}" "Seed test database (SEED_TEST_DATABASE_URL)" || EXIT_CODE=1

exit $EXIT_CODE
