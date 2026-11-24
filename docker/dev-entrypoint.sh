#!/bin/sh
# docker/dev-entrypoint.sh - start the compose (dev-stage) container.
#
# docker-compose.yml mounts ./apps, ./packages and ./drizzle from the host for
# hot reload. Those trees can carry node_modules and dist/ output from an
# older checkout (v0.6 used pnpm), which would leave new source running
# against stale builds. On every start this script:
#   1. when package-lock.json changed since the last start (or on the first
#      start after an upgrade), replaces the mounted workspaces' node_modules
#      with a fresh npm install;
#   2. rebuilds the packages, so dist/ always matches the mounted source;
#   3. rebuilds the dashboard with NODE_ENV=production (the compose env is
#      development, which would bundle development React);
#   4. starts the server in watch mode.
# Any failure stops the container: a down container is loud, a stale one is
# silent.
set -eu
cd /app

# The stamp lives in a mounted directory, so it survives container restarts
# and tells whether the host-side node_modules match this image's lockfile.
STAMP=/app/packages/.claros-lock-sha
lock_sha="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$lock_sha" ]; then
  echo "[claros] dependencies changed (or first start after an upgrade): reinstalling workspace node_modules"
  rm -rf apps/*/node_modules packages/*/node_modules drizzle/node_modules
  npm install --no-audit --no-fund --loglevel=error
  echo "$lock_sha" > "$STAMP"
fi

npm run build --silent \
  -w @claros/core -w @claros/adapters -w @claros/brain-oss -w @claros/db \
  -w @claros/api -w @claros/worker -w @claros/scheduler

# The image has no .git, so Tailwind's content scan would pick up class
# strings from a previous dist; remove it first.
rm -rf apps/dashboard/dist
NODE_ENV=production npm run build --silent -w @claros/dashboard

exec node --import /app/node_modules/tsx/dist/esm/index.mjs --watch apps/server/src/main.ts "$@"
