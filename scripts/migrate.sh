#!/usr/bin/env bash
set -euo pipefail

# migrate.sh - Run community schema migrations via drizzle-kit.
#
# Default target: DATABASE_URL (local Postgres).
# Remote:        PRODUCTION_DATABASE_URL (a direct, non-pooled endpoint), via --prod flag.
#
# Drizzle-kit records the journal row atomically with the DDL, so schema changes
# must always go through this script - never raw psql.
#
# Usage:
#   npm run db:migrate           # local database, prompts for confirmation
#   npm run db:migrate -- --yes  # local database, no prompt (CI)
#   npm run db:migrate -- --prod # remote production database, prompts for confirmation
#   npm run db:migrate -- --prod --yes  # production + no prompt

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
YES=false
PROD=false

for arg in "$@"; do
  case "$arg" in
    --yes) YES=true ;;
    --prod) PROD=true ;;
    --) ;;  # a literal "--" separator can arrive from "npm run db:migrate -- --flag"; ignore it
  esac
done

# Load .env if present (safe line-by-line parser - never sources the file).
# Values containing &, $, #, spaces, or other shell metacharacters are handled
# correctly because the value is never evaluated by the shell.
ENV_FILE="$REPO_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blank lines and comments
    case "$line" in
      ""|\#*) continue ;;
    esac

    # Must look like KEY=VALUE (KEY is alphanumeric + underscore)
    if ! echo "$line" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*='; then
      continue
    fi

    key="${line%%=*}"
    value="${line#*=}"

    # Strip surrounding quotes (single or double) from the value.
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

# ---------------------------------------------------------------------------
# Resolve target URL
# ---------------------------------------------------------------------------

if [ "$PROD" = true ]; then
  # --prod: use PRODUCTION_DATABASE_URL
  if [ -z "${PRODUCTION_DATABASE_URL:-}" ]; then
    echo ""
    echo "ERROR: --prod requires PRODUCTION_DATABASE_URL to be set."
    echo ""
    echo "This variable holds the direct (non-pooled) connection string of the remote database."
    echo "Set it in .env or your environment:"
    echo ""
    echo "  PRODUCTION_DATABASE_URL='postgresql://user:pass@ep-xxx.region.aws.neon.tech/dbname?sslmode=require'"
    echo ""
    exit 1
  fi
  TARGET_URL="$PRODUCTION_DATABASE_URL"
else
  # Default: use DATABASE_URL (local)
  if [ -z "${DATABASE_URL:-}" ]; then
    echo ""
    echo "ERROR: DATABASE_URL is not set."
    echo ""
    echo "Migrations default to the local database (DATABASE_URL)."
    echo "Set it in .env or your environment:"
    echo ""
    echo "  DATABASE_URL='postgres://claros:claros@localhost:5433/claros'"
    echo ""
    echo "For a remote production database, use: npm run db:migrate -- --prod"
    exit 1
  fi
  TARGET_URL="$DATABASE_URL"
fi

# ---------------------------------------------------------------------------
# Parse host and database from the connection string for display
# ---------------------------------------------------------------------------

# Strip scheme: postgres:// or postgresql://
stripped="${TARGET_URL#postgres://}"
stripped="${stripped#postgresql://}"

# Strip userinfo (user:pass@)
host_db="${stripped#*@}"

# host:port/dbname?params - extract host:port part
host_port="${host_db%%/*}"

# database name: after the first slash, before any ?
db_and_params="${host_db#*/}"
db_name="${db_and_params%%\?*}"
if [ -z "$db_name" ]; then
  db_name="(none)"
fi

# ---------------------------------------------------------------------------
# Safety checks
# ---------------------------------------------------------------------------

# Reject pooled endpoints (contain "-pooler" in hostname).
# These fail partway through with prepared-statement errors.
if echo "$host_port" | grep -qi "\-pooler"; then
  echo ""
  echo "ERROR: Target URL points to a pooled connection endpoint."
  echo ""
  echo "  Host given: $host_port"
  echo ""
  echo "Pooled endpoints (containing \"-pooler\" in the hostname) cannot be used"
  echo "for migrations. Drizzle uses prepared statements that poolers do not support."
  echo ""
  echo "Use the direct endpoint instead. On Neon the direct hostname looks like:"
  echo "  ep-<name>.<region>.aws.neon.tech  (no \"-pooler\" suffix)"
  echo ""
  exit 1
fi

# Cross-check: if --prod was NOT passed, refuse if the target looks remote.
# This prevents a misconfigured DATABASE_URL from silently hitting production.
if [ "$PROD" = false ]; then
  if echo "$host_port" | grep -qi "neon\.tech"; then
    echo ""
    echo "ERROR: DATABASE_URL points to a remote Neon endpoint, but --prod was not passed."
    echo ""
    echo "  Host: $host_port"
    echo ""
    echo "The default target (without --prod) must be a local database."
    echo "If you intend to migrate production, use:"
    echo ""
    echo "  npm run db:migrate -- --prod"
    echo ""
    echo "If your DATABASE_URL is wrong, fix it in .env to point at localhost."
    exit 1
  fi
fi

# Detect endpoint type for display
if echo "$host_port" | grep -qi "neon\.tech"; then
  endpoint_type="Neon (production)"
elif echo "$host_port" | grep -qi "localhost\|127\.0\.0\.\|::1"; then
  endpoint_type="local"
else
  endpoint_type="remote (unknown)"
fi

# ---------------------------------------------------------------------------
# Confirmation
# ---------------------------------------------------------------------------

echo ""
echo "=== Claros Migration Runner ==="
echo ""
echo "Target:"
echo "  Host:     $host_port"
echo "  Database: $db_name"
echo "  Type:     $endpoint_type"
if [ "$PROD" = true ]; then
  echo "  Mode:     PRODUCTION (--prod)"
fi
echo ""

if [ "$endpoint_type" != "local" ] && [ "$PROD" = false ]; then
  echo "WARNING: This appears to be a remote endpoint."
  echo "         Verify this is intentional and that you have a backup."
  echo ""
fi

if [ "$YES" = false ]; then
  printf "Apply migrations to %s/%s? [y/N] " "$host_port" "$db_name"
  read -r reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *)
      echo ""
      echo "Aborted. No migrations applied."
      exit 0
      ;;
  esac
  echo ""
fi

# ---------------------------------------------------------------------------
# Run drizzle-kit migrate
# ---------------------------------------------------------------------------

echo "Running drizzle-kit migrate..."
echo ""

# drizzle.config.ts resolves URL from DATABASE_URL. Export our resolved target
# as DATABASE_URL so drizzle-kit sees it regardless of which variable sourced it.
export DATABASE_URL="$TARGET_URL"

"$REPO_ROOT/node_modules/.bin/drizzle-kit" migrate \
  --config "$REPO_ROOT/drizzle/drizzle.config.ts"

echo ""
echo "Migration complete."
