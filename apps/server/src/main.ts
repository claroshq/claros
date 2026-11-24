/**
 * Server entrypoint.
 *
 * Parses --role from argv, creates DB connection, runs startup migrations,
 * runs bootstrap seed check, then starts the appropriate services
 * (API, worker, scheduler).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { buildApp } from "@claros/api";
import { tenants, users } from "@claros/db/schema";
import { eq } from "drizzle-orm";
import { createBoss, startWorker } from "@claros/worker";
import { startScheduler } from "@claros/scheduler";

const VALID_ROLES = ["all", "api", "worker", "scheduler"] as const;
type Role = (typeof VALID_ROLES)[number];

function parseRole(): Role {
  const raw = process.argv.find((a) => a.startsWith("--role="))?.split("=")[1] ?? "all";
  if (!VALID_ROLES.includes(raw as Role)) {
    console.error(`Invalid role: ${raw}. Valid: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }
  return raw as Role;
}

const role = parseRole();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
/**
 * Reported in /health and /version for v0.6 API compatibility. Claros has a
 * single open-source edition; the CLAROS_EDITION env var is no longer read.
 */
const edition = "community";

/**
 * Bootstrap seed: ensure one default tenant exists on first boot.
 *
 * Changed from original: SEED_ADMIN_EMAIL is now OPTIONAL.
 * - If set: creates tenant + owner (automated provisioning path, unchanged).
 * - If unset with empty DB: creates tenant only; the claim flow (below)
 *   handles first-user creation via the browser.
 *
 * Idempotent at the database level: the entire operation runs inside a single
 * transaction. The tenant insert uses ON CONFLICT (slug) DO NOTHING - the
 * UNIQUE constraint on tenants.slug is the serialisation point. If N processes
 * call bootstrapSeed concurrently against an empty database, exactly one will
 * insert the tenant row; the others will receive an empty RETURNING result and
 * fall through to SELECT the winner's id. The user insert similarly uses
 * ON CONFLICT (tenant_id, email) DO NOTHING backed by uq_users_tenant_email.
 * All callers complete without error; exactly one tenant and one user exist.
 *
 * If the database already has any tenants the function returns immediately -
 * the SELECT and the transaction are both skipped.
 *
 * Called only on roles that serve HTTP (api, all). Worker and scheduler skip
 * this entirely - they have no login surface and need no seed tenant.
 *
 * Returns true if a fresh tenant was created (signals the claim flow should
 * mint a token), false otherwise.
 */
async function bootstrapSeed(db: ReturnType<typeof drizzle>): Promise<boolean> {
  const seedEmail = process.env.SEED_ADMIN_EMAIL;
  const normalizedEmail = seedEmail ? seedEmail.toLowerCase().trim() : null;

  let freshInstall = false;

  await db.transaction(async (tx) => {
    // Fast-path: if any tenant exists, nothing to do.
    const existing = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .limit(1);
    if (existing.length > 0) return;

    freshInstall = true;

    // Attempt to insert the seed tenant. ON CONFLICT (slug) DO NOTHING means
    // exactly one of N concurrent callers inserts; the rest skip silently.
    const inserted = await tx
      .insert(tenants)
      .values({ name: "Default", slug: "default", plan: "free" })
      .onConflictDoNothing()
      .returning({ id: tenants.id });

    // Resolve the tenant id whether we inserted or lost the race.
    const tenantId =
      inserted.length > 0
        ? inserted[0]!.id
        : (
            await tx
              .select({ id: tenants.id })
              .from(tenants)
              .where(eq(tenants.slug, "default"))
              .limit(1)
          )[0]!.id;

    // If SEED_ADMIN_EMAIL is set, create the owner user (automated path).
    if (normalizedEmail) {
      await tx
        .insert(users)
        .values({ tenantId, email: normalizedEmail, role: "owner" })
        .onConflictDoNothing();

      if (inserted.length > 0) {
        console.log("");
        console.log("=== Bootstrap Seed ===");
        console.log(`  Tenant ID : ${tenantId}`);
        console.log(`  Owner     : ${normalizedEmail}`);
        console.log("  Seed complete. You can now request a login link.");
        console.log("======================");
        console.log("");
      }
    } else if (inserted.length > 0) {
      console.log("");
      console.log("=== Bootstrap ===");
      console.log(`  Tenant ID : ${tenantId}`);
      console.log("  No SEED_ADMIN_EMAIL - claim flow active (see URL below).");
      console.log("==================");
      console.log("");
    }
  });

  return freshInstall;
}

async function start(): Promise<void> {
  // Create database connection
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }

  // Reject pooled/pgbouncer endpoints at startup. pg-boss depends on session
  // persistence (prepared statements, LISTEN/NOTIFY, advisory locks). A pooled
  // connection silently breaks all three, causing missed job notifications and
  // potential double-processing. Fail loudly here rather than mysteriously later.
  try {
    const parsed = new URL(databaseUrl);
    if (/-pooler/i.test(parsed.host)) {
      console.error("ERROR: DATABASE_URL points to a pooled endpoint (hostname contains '-pooler').");
      console.error("pg-boss requires a direct connection for session persistence, LISTEN/NOTIFY, and advisory locks.");
      console.error("Use the direct (non-pooler) endpoint instead.");
      process.exit(1);
    }
    if (parsed.searchParams.get("pgbouncer") === "true") {
      console.error("ERROR: DATABASE_URL has ?pgbouncer=true query parameter.");
      console.error("pg-boss requires a direct connection for session persistence, LISTEN/NOTIFY, and advisory locks.");
      console.error("Remove the pgbouncer parameter and use a direct connection.");
      process.exit(1);
    }
  } catch {
    // If URL parsing fails, let pg.Pool surface the connection error downstream.
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  // Provisional signal handler: registered immediately after the pool is
  // created so that a SIGTERM arriving during the startup sequence (before
  // the full handler at the bottom of start() is registered) does not
  // leave the pool open. The provisional handler sets a flag; the main
  // handler below replaces it and runs the full sequence. If the main
  // handler never gets registered (because a startup step calls
  // process.exit(1) before we reach it), the provisional handler's flag
  // is irrelevant and Node exits cleanly through the process.exit() call.
  let shutdownRequestedEarly = false;
  const provisionalHandler = () => { shutdownRequestedEarly = true; };
  process.once("SIGTERM", provisionalHandler);
  process.once("SIGINT", provisionalHandler);

  // Auto-migrate: apply pending community schema migrations on startup.
  //
  // GATE: only runs when CLAROS_MIGRATE_ON_BOOT=true is explicitly set.
  // This is an opt-in, not an opt-out. The fail-safe direction is CLOSED:
  // if the variable is absent, empty, or any value other than the exact
  // string "true", migration does NOT run.
  //
  // Why this gate matters:
  //   Cloud deploys (Neon) must never have the container apply migrations
  //   autonomously. The expand-contract discipline, target confirmation,
  //   pooler rejection, and Umut-approval flow are all enforced by
  //   scripts/migrate.sh, not by this code path. Removing that control
  //   at scale (multiple pods booting concurrently against Neon) is a
  //   data integrity risk regardless of Drizzle's idempotency claim.
  //
  // Who sets it:
  //   docker-compose.yml sets CLAROS_MIGRATE_ON_BOOT=true.
  //   Cloud deploy (wrangler) does not set it. Local .env can set it for
  //   npm run dev convenience, but never ships to production.
  //
  // Cases:
  //   - local compose (CLAROS_MIGRATE_ON_BOOT=true):  migrate() runs.
  //   - Cloud production (var absent):                migrate() is skipped.
  //   - Signal absent or any other value:             migrate() is skipped.
  if (process.env.CLAROS_MIGRATE_ON_BOOT === "true") {
    // Migrations folder resolves relative to this compiled file so it
    // works inside the Docker image (/app/drizzle/migrations) and locally.
    // Compiled output: apps/server/dist/main.js - three levels up = repo root.
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = path.resolve(__dirname, "../../../drizzle/migrations");
    try {
      await migrate(db, { migrationsFolder });
      console.log("[migrate] community schema up to date");
    } catch (err) {
      console.error("[migrate] failed to apply migrations:", err);
      process.exit(1);
    }
  }

  // Warn (not fail) if ENCRYPTION_KEY is absent. The server can start and
  // serve the quickstart path without it. Flow compilation and LLM config
  // storage will fail at first use with a clear error message.
  if (!process.env.ENCRYPTION_KEY) {
    console.warn("[config] ENCRYPTION_KEY not set - LLM config storage and flow compilation will be unavailable until configured.");
  }

  // Warn (not fail) if UNSUBSCRIBE_SIGNING_KEY is absent. The server starts
  // without it, but approved messages will not be sent: the drain reverts
  // every message to 'approved' rather than producing tokens without a key.
  // A missing key is a configuration fault that blocks sending, not a crash.
  // Set UNSUBSCRIBE_SIGNING_KEY before sending real mail. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // PERMANENT: once set and mail is delivered, this key must never change.
  if (!process.env.UNSUBSCRIBE_SIGNING_KEY) {
    console.warn("[config] UNSUBSCRIBE_SIGNING_KEY not set - sending is blocked until configured. Generate once and treat as permanent.");
  }

  // Warn (not fail) if BASE_URL is unusable in production.
  //
  // A localhost/loopback or non-https BASE_URL in production means every
  // outgoing email would have its unsubscribe link permanently baked in with
  // the wrong value. That cannot be corrected for messages already delivered.
  // The drain enforces this as a hard block (messages revert to 'approved'),
  // but the startup warning surfaces the problem at boot rather than at the
  // first send attempt.
  //
  // Why warn rather than refuse to start: refusing would strand the self-host
  // quickstart (docker compose up) which legitimately uses http://localhost:3000
  // and does not set NODE_ENV=production. The drain-level check is the hard
  // enforcement; this warning is the early signal for operators who do set
  // NODE_ENV=production.
  if (process.env.NODE_ENV === "production") {
    const rawBaseUrl = process.env.BASE_URL;
    if (!rawBaseUrl) {
      console.warn(
        "[config] BASE_URL is not set. In production the default (http://localhost:3000) is unusable: " +
        "unsubscribe links baked into delivered emails would point at localhost and cannot be corrected. " +
        "Set BASE_URL to the HTTPS domain where Claros is hosted before the first send.",
      );
    } else {
      // Minimal parse check at startup. The drain checkBaseUrl() is the authoritative
      // enforcement; this mirrors its logic without importing from packages/worker.
      try {
        const parsed = new URL(rawBaseUrl);
        const loopback = parsed.hostname === "localhost" ||
          parsed.hostname === "127.0.0.1" ||
          parsed.hostname === "::1" ||
          parsed.hostname === "[::1]" ||
          /^127\.\d+\.\d+\.\d+$/.test(parsed.hostname);
        if (loopback) {
          console.warn(
            `[config] BASE_URL is set to a loopback address ("${parsed.hostname}") in production. ` +
            "Unsubscribe links baked into delivered emails would point at localhost and cannot be corrected. " +
            "The drain will block all sends until BASE_URL is set to the HTTPS domain where Claros is hosted.",
          );
        } else if (parsed.protocol !== "https:") {
          console.warn(
            `[config] BASE_URL uses scheme "${parsed.protocol.replace(":", "")}" instead of https in production. ` +
            "Unsubscribe links baked into delivered emails would use an insecure scheme. " +
            "The drain will block all sends until BASE_URL is set to an https:// URL.",
          );
        }
      } catch {
        console.warn(
          `[config] BASE_URL "${rawBaseUrl}" is not a valid URL in production. ` +
          "The drain will block all sends until BASE_URL is set to the HTTPS domain where Claros is hosted.",
        );
      }
    }

    // Warn if DASHBOARD_URL is set but is loopback or non-https in production.
    // A wrong DASHBOARD_URL means /auth/verify redirects to an unreachable host,
    // locking operators out. The server still starts; this is an early signal.
    const rawDashboardUrl = process.env.DASHBOARD_URL;
    if (rawDashboardUrl) {
      try {
        const parsed = new URL(rawDashboardUrl);
        const loopback = parsed.hostname === "localhost" ||
          parsed.hostname === "127.0.0.1" ||
          parsed.hostname === "::1" ||
          parsed.hostname === "[::1]" ||
          /^127\.\d+\.\d+\.\d+$/.test(parsed.hostname);
        if (loopback) {
          console.warn(
            `[config] DASHBOARD_URL is set to a loopback address ("${parsed.hostname}") in production. ` +
            "The /auth/verify redirect would point at localhost. Operators would be unable to log in. " +
            "Set DASHBOARD_URL to the HTTPS domain where the dashboard is hosted.",
          );
        } else if (parsed.protocol !== "https:") {
          console.warn(
            `[config] DASHBOARD_URL uses scheme "${parsed.protocol.replace(":", "")}" instead of https in production. ` +
            "Set DASHBOARD_URL to an https:// URL.",
          );
        }
      } catch {
        console.warn(
          `[config] DASHBOARD_URL "${rawDashboardUrl}" is not a valid URL in production. ` +
          "Set DASHBOARD_URL to the HTTPS domain where the dashboard is hosted.",
        );
      }
    }
  }

  // Bootstrap seed: only relevant for roles that serve HTTP (api, all).
  // Worker and scheduler have no login surface and no reason to know whether
  // a seed tenant exists. Running seed on every role also introduces a
  // startup race: multiple processes against an empty DB all read count=0
  // simultaneously and each inserts a tenant row, producing duplicates.
  // Claim flow: when no users exist, generate a one-time claim token and log
  // a prominent URL. The person opens it in a browser to create the first owner.
  // Regenerated on every restart while unclaimed (latest logs win).
  let claimToken: string | null = null;
  if (role === "all" || role === "api") {
    await bootstrapSeed(db);

    // Check if any users exist. If not, mint a claim token.
    const userCount = await db
      .select({ id: users.id })
      .from(users)
      .limit(1);
    if (userCount.length === 0) {
      const { randomBytes: rb } = await import("node:crypto");
      claimToken = rb(32).toString("base64url");
    }
  }

  // pg-boss: every role needs at least one boss instance.
  // - role=all: one instance handles enqueue (API), work (worker), and schedule.
  // - role=api: a lightweight instance for enqueue only (no work, no schedule).
  // - role=worker: work handlers only (no schedule).
  // - role=scheduler: cron schedules only (no work).
  const boss = createBoss(databaseUrl, {
    schedule: role === "all" || role === "scheduler",
  });

  boss.on("error", (err) => {
    console.error("[pg-boss] error:", err);
  });

  await boss.start();
  console.log(`[pg-boss] started (role=${role}, schema=pgboss)`);

  // Enqueue function: wraps boss.send() for the API layer.
  const enqueue = async (
    queue: string,
    data: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): Promise<string | null> => {
    return boss.send(queue, data, opts ?? {});
  };

  // API roles: "all" and "api" start the HTTP server.
  //
  // app is declared here (outside the conditional block) so the shutdown
  // closure below can capture it. It remains undefined for pure worker and
  // scheduler roles that never start Fastify.
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  if (role === "all" || role === "api") {
    // CLAROS_SERVE_DASHBOARD controls @fastify/static serving of the built
    // dashboard SPA and the SPA catch-all fallback.
    //
    // Default: true. An explicit CLAROS_SERVE_DASHBOARD="false" disables it
    // (for example when a reverse proxy serves the dashboard).
    //
    // If enabled but apps/dashboard/dist does not exist, a warning is logged
    // and serving is skipped - the server still starts cleanly.
    const serveDashboard = process.env.CLAROS_SERVE_DASHBOARD !== "false";

    app = await buildApp({ role, edition, db, enqueue, serveDashboard, claimToken });

    try {
      await app.listen({ port, host });
      app.log.info(`Claros server started (role=${role}) on ${host}:${port}`);

      // Log the claim URL prominently when no users exist.
      if (claimToken) {
        const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
        const claimUrl = `${baseUrl}/claim?token=${claimToken}`;
        console.log("");
        console.log("╔══════════════════════════════════════════════════════════════╗");
        console.log("║  CLAIM YOUR ACCOUNT                                         ║");
        console.log("║                                                             ║");
        console.log("║  No users exist yet. Open this URL to create the first      ║");
        console.log("║  owner account:                                             ║");
        console.log("║                                                             ║");
        console.log(`║  ${claimUrl}`);
        console.log("║                                                             ║");
        console.log("║  This link is single-use and regenerates on each restart.   ║");
        console.log("╚══════════════════════════════════════════════════════════════╝");
        console.log("");
      }
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  }

  // Worker: register job handlers.
  if (role === "all" || role === "worker") {
    await startWorker(boss, db);
    console.log("[pg-boss] worker handlers registered");
  }

  // Scheduler: register cron schedules.
  if (role === "all" || role === "scheduler") {
    await startScheduler(boss);
    console.log("[pg-boss] cron schedules registered");
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  //
  // Order:
  //   1. app.close()  - stop accepting new HTTP connections; wait for
  //                     in-flight requests to finish. forceCloseConnections
  //                     is set on the Fastify instance so keep-alive
  //                     connections are destroyed immediately rather than
  //                     waiting for the remote end to close them. Without
  //                     this the keep-warm cron (every 60 s) would hold a
  //                     persistent connection open and app.close() would
  //                     hang exactly as boss.stop() used to.
  //   2. boss.stop()  - stop pg-boss pollers and wait (up to 10 s) for
  //                     any in-flight job cleanups. Job cleanup may still
  //                     need the database pool, so this runs before pool.end.
  //   3. pool.end()   - drain the pg.Pool used by Drizzle. This is the
  //                     handle that kept the event loop alive before this fix.
  //
  // Watchdog: a timer fires process.exit(1) after SHUTDOWN_BUDGET_MS if the
  // sequence above has not completed. The timer is unref'd so it cannot
  // itself keep the event loop alive if all other handles drain first.
  // The budget is 30 s: pg-boss graceful window (10 s) + app.close drain
  // (<1 s with forceCloseConnections) + pool.end drain (<1 s) + 18 s
  // safety margin. This is well under Cloudflare's 15-minute SIGKILL ceiling
  // and far above the measured clean-shutdown cost (~2 s after the fix).
  // ---------------------------------------------------------------------------

  const SHUTDOWN_BUDGET_MS = 30_000;
  let shutdownInProgress = false;

  const shutdown = async () => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    // Watchdog: fires only if the sequence below hangs.
    const watchdog = setTimeout(() => {
      console.error(
        "[shutdown] WATCHDOG: graceful shutdown exceeded budget of " +
        `${SHUTDOWN_BUDGET_MS / 1000} s. A handle was not closed. Forcing exit.`,
      );
      process.exit(1);
    }, SHUTDOWN_BUDGET_MS);
    watchdog.unref();

    try {
      // Step 1: stop accepting HTTP connections.
      if (app) {
        console.log("[shutdown] closing HTTP server...");
        await app.close();
        console.log("[shutdown] HTTP server closed");
      }

      // Step 2: stop pg-boss pollers and drain in-flight job cleanups.
      console.log("[shutdown] stopping pg-boss...");
      await boss.stop({ graceful: true, timeout: 10_000 });
      console.log("[shutdown] pg-boss stopped");

      // Step 3: drain the database pool.
      console.log("[shutdown] draining database pool...");
      await pool.end();
      console.log("[shutdown] database pool closed");

      console.log("[shutdown] clean exit");
      process.exit(0);
    } catch (err) {
      console.error("[shutdown] error during shutdown sequence:", err);
      process.exit(1);
    }
  };

  // Remove the provisional handlers and register the real ones.
  process.off("SIGTERM", provisionalHandler);
  process.off("SIGINT", provisionalHandler);
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  // If a signal arrived during startup (before the real handlers were
  // installed), run the full shutdown now.
  if (shutdownRequestedEarly) {
    console.log("[shutdown] signal received during startup - shutting down now");
    void shutdown();
  }
}

start();
