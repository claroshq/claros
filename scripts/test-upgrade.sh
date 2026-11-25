#!/usr/bin/env bash
# scripts/test-upgrade.sh - Upgrade test from a real v0.6.4 database.
#
# Restores fixtures/v0.6.4.sql.gz (a seeded v0.6.4 install) into a fresh
# database, applies the current migrations on top, checks that no data was
# lost, then boots the server against it and checks /health.
#
# Env:
#   UPGRADE_ADMIN_URL  connection URL of a database used to create/drop the
#                      test database (default: postgres://claros:claros@localhost:5432/postgres)
#   PSQL               psql command (default: psql). Locally without psql:
#                      PSQL="docker exec -i <postgres container> psql -U claros"
#                      (then UPGRADE_DB_HOST_URL must be reachable from the host)
#
# Requires `npm run build` (boots apps/server/dist/main.js).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ADMIN_URL="${UPGRADE_ADMIN_URL:-postgres://claros:claros@localhost:5432/postgres}"
PSQL="${PSQL:-psql}"
DB_NAME="claros_upgrade_test"
DB_URL="${ADMIN_URL%/*}/${DB_NAME}"
PORT_UNDER_TEST="${UPGRADE_PORT:-3997}"

# shellcheck disable=SC2086
psql_admin() { $PSQL "$ADMIN_URL" -v ON_ERROR_STOP=1 -q "$@"; }
# shellcheck disable=SC2086
psql_db() { $PSQL "$DB_URL" -v ON_ERROR_STOP=1 -q "$@"; }

counts() {
  psql_db -tA -c "
    select 'tenants', count(*) from tenants union all
    select 'users', count(*) from users union all
    select 'contacts', count(*) from contacts union all
    select 'events', count(*) from events union all
    select 'flows', count(*) from flows union all
    select 'flow_memberships', count(*) from flow_memberships union all
    select 'lifecycle_messages', count(*) from lifecycle_messages
    order by 1"
}

echo "==> restore v0.6.4 fixture into ${DB_NAME}"
psql_admin -c "drop database if exists ${DB_NAME}" -c "create database ${DB_NAME}"
gunzip -c fixtures/v0.6.4.sql.gz | psql_db >/dev/null

before="$(counts)"
echo "$before"

echo "==> apply current migrations"
DATABASE_URL="$DB_URL" bash scripts/migrate.sh --yes

after="$(counts)"
if [ "$before" != "$after" ]; then
  echo "upgrade test: row counts changed by the migration" >&2
  diff <(echo "$before") <(echo "$after") >&2 || true
  exit 1
fi
echo "row counts unchanged"

echo "==> check the multi-product backfill"
# Every existing user has a membership of their home product with their role,
# and the instance admins are exactly the active owners of the oldest product.
backfill="$(psql_db -tA -c "
  select
    (select count(*) from users) = (select count(*) from memberships)
    and not exists (
      select 1 from users u
      left join memberships m on m.user_id = u.id and m.tenant_id = u.tenant_id
      where m.role is distinct from u.role)
    and (select array_agg(id order by id) from users where instance_role = 'admin')
      is not distinct from
      (select array_agg(id order by id) from users
       where role = 'owner' and deactivated_at is null
         and tenant_id = (select id from tenants order by created_at asc nulls last, id asc limit 1))")"
if [ "$backfill" != "t" ]; then
  echo "upgrade test: memberships / instance admin backfill is wrong" >&2
  psql_db -c "select u.email, u.role, u.instance_role, m.role as membership_role from users u left join memberships m on m.user_id = u.id" >&2 || true
  exit 1
fi
psql_db -tA -c "select 'memberships', count(*) from memberships union all select 'instance_admins', count(*) from users where instance_role = 'admin'"

echo "==> boot server on the upgraded database"
DATABASE_URL="$DB_URL" PORT="$PORT_UNDER_TEST" HOST=127.0.0.1 NODE_ENV=production \
  ENCRYPTION_KEY="$(openssl rand -base64 32)" UNSUBSCRIBE_SIGNING_KEY="$(openssl rand -hex 32)" \
  BASE_URL="http://localhost:${PORT_UNDER_TEST}" CLAROS_SERVE_DASHBOARD=false LOG_LEVEL=warn \
  node apps/server/dist/main.js --role=all &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT_UNDER_TEST}/health" >/dev/null; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:${PORT_UNDER_TEST}/health" | grep -q '"status":"ok"'
echo "upgrade test passed"
