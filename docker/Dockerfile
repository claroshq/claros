# Stage 1: Builder - installs all deps (including devDeps) and builds dist files.
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifests first for better layer caching. npm workspaces need
# every workspace package.json present before `npm ci`.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY packages/api/package.json packages/api/
COPY packages/worker/package.json packages/worker/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/brain-oss/package.json packages/brain-oss/
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
# drizzle/ is workspace package @claros/db
COPY drizzle/package.json drizzle/

RUN npm ci

# Copy source
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/
# Full drizzle package: tsconfig.json + schema/ required by tsc --build;
# migrations/ required at runtime for in-process auto-migrate on startup.
COPY drizzle/ drizzle/

# Remove any .tsbuildinfo that may have been included in the build context
# (e.g. from a development tree where the build already ran). tsbuildinfo
# files are in .gitignore and absent from a clean git clone, but a direct
# directory copy can include them. If they exist here, tsc --build considers
# every package up to date and skips emitting .js/.d.ts without error.
RUN find . -name 'tsconfig.tsbuildinfo' -not -path '*/node_modules/*' -delete

RUN npm run build

# Stage 2: Dev - keeps all deps (including tsx) for hot reload.
# docker-compose.yml mounts the source over /app so file changes are visible
# immediately; node_modules stays from this image layer (Linux binaries).
FROM node:22-alpine AS dev

WORKDIR /app

# All deps including devDeps (tsx, vitest, etc.) - needed for `tsx watch`.
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/tsconfig.base.json ./
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/apps/ apps/
COPY --from=builder /app/drizzle/ drizzle/

RUN chmod +x /app/apps/server/bin/claros.mjs \
    && ln -s /app/apps/server/bin/claros.mjs /usr/local/bin/claros

COPY .env.example .env.example

EXPOSE 3000

# Hot reload: Node's built-in --watch with tsx as the TypeScript loader.
# tsx watch uses its own file watcher; node --watch uses inotify on Linux.
# On macOS Docker Desktop with grpcFUSE, inotify events from volume mounts
# are not reliably delivered. Switch Docker Desktop to VirtioFS (Settings ->
# General -> Virtual Machine Options -> VirtioFS) for reliable hot reload.
# The server starts correctly either way; only reload-on-save is affected.
#
# Dashboard freshness: docker-compose.yml mounts ./apps over /app/apps, which
# masks the dist built in this image with whatever apps/dashboard/dist on the
# host happens to contain. Building the dashboard here, on every container
# start, makes a stale dist impossible: the served assets always match the
# mounted source. If the build fails the container exits instead of serving
# old assets - a down container is loud, a stale one is silent.
# Two build hygiene details:
#   - rm -rf dist first: the image has no .git, so Tailwind's content scan
#     does not apply .gitignore rules and would otherwise pick up class
#     strings from the previous dist, bloating the CSS.
#   - NODE_ENV=production for the build only: the compose environment sets
#     NODE_ENV=development, which would make Vite bundle development React
#     (roughly 1.7x the JS). The server itself still runs with
#     NODE_ENV=development so the console login fallback keeps working.
ENTRYPOINT ["sh", "-c", "rm -rf apps/dashboard/dist && NODE_ENV=production npm run build -w @claros/dashboard && exec node --import /app/node_modules/tsx/dist/esm/index.mjs --watch apps/server/src/main.ts \"$@\"", "sh"]
CMD ["--role=all"]

# Stage 3: Runner - production image, prod deps only.
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Build provenance: commit SHA and build timestamp injected at image build time.
# Pass --build-arg COMMIT_SHA=<sha> when invoking docker build.
# A locally built image that omits the argument gets an empty string, which the
# /version endpoint normalises to "unknown". Never crashes; never blocks startup.
ARG COMMIT_SHA=""
ARG BUILT_AT=""
ENV CLAROS_COMMIT_SHA=${COMMIT_SHA}
ENV CLAROS_BUILT_AT=${BUILT_AT}

# Copy built output and production deps
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/tsconfig.base.json ./
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/apps/ apps/
# drizzle/ workspace package (@claros/db): needs dist/schema/ for runtime imports
# and migrations/ for in-process auto-migrate on startup.
COPY --from=builder /app/drizzle/package.json drizzle/
COPY --from=builder /app/drizzle/dist drizzle/dist
COPY --from=builder /app/drizzle/migrations drizzle/migrations

RUN npm ci --omit=dev

# Make the claros CLI available as a short command in PATH.
RUN chmod +x /app/apps/server/bin/claros.mjs \
    && ln -s /app/apps/server/bin/claros.mjs /usr/local/bin/claros

COPY .env.example .env.example

EXPOSE 3000

# Default: run all roles. Override with --role=api|worker|scheduler
ENTRYPOINT ["node", "apps/server/dist/main.js"]
CMD ["--role=all"]
