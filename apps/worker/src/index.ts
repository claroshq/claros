/**
 * Claros on Cloudflare Workers: one Worker on D1.
 *
 *   fetch      the HTTP API (the same Hono app as apps/server) and the
 *              dashboard from Static Assets with the Node SPA fallback rules
 *   queue      consumer of JOBS (claros-jobs): each message is one job, run by
 *              the same runJob() the pg-boss workers use; and of the dead
 *              letter queue (claros-jobs-dlq): dead jobs are logged
 *   scheduled  one Cron Trigger every 5 minutes; dueTicks() picks the
 *              periodic jobs due at that tick and they are enqueued on JOBS
 *
 * Roles still communicate only through the database (D1) and the job queue.
 * Configuration (BASE_URL, ENCRYPTION_KEY, UNSUBSCRIBE_SIGNING_KEY, ...) is
 * read from process.env by the shared packages; see syncProcessEnv().
 */
import { drizzle } from "drizzle-orm/d1";
import { buildApp, spaFallback, type ClarosApp, type Db, type EnqueueFn, type StaticFallback } from "@claros/api";
import { dueTicks } from "@claros/core";
import { createD1Store, registerStore } from "@claros/store";
import { consumeDeadJobs, consumeJobs, queueEnqueue } from "./jobs.js";
import type { Env, ExecutionContext, Fetcher, JobMessage, MessageBatch, ScheduledController } from "./bindings.js";

export type { Env, JobMessage } from "./bindings.js";

// ---------------------------------------------------------------------------
// Per-isolate state
// ---------------------------------------------------------------------------

interface Runtime {
  db: Db;
  enqueue: EnqueueFn;
  app: Promise<ClarosApp> | null;
}

/** One Drizzle handle (with its D1 Store registered) and one app per D1 binding. */
const runtimes = new WeakMap<object, Runtime>();

function runtime(env: Env): Runtime {
  let rt = runtimes.get(env.DB);
  if (!rt) {
    const db = drizzle(env.DB as never) as unknown as Db;
    registerStore(db, createD1Store(db as never));
    rt = { db, enqueue: queueEnqueue(env.JOBS), app: null };
    runtimes.set(env.DB, rt);
  }
  return rt;
}

/**
 * Copy string bindings (vars and secrets) into process.env.
 *
 * The shared packages read their configuration from process.env, as on Node.
 * With `nodejs_compat` and a compatibility date from 2025-04-01 the runtime
 * already populates process.env from vars and secrets; this keeps that true
 * if the flag is ever turned off, and never overrides a value already there.
 */
function syncProcessEnv(env: Env): void {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && process.env[key] === undefined) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function app(env: Env): Promise<ClarosApp> {
  const rt = runtime(env);
  if (!rt.app) {
    const assets = env.ASSETS;
    rt.app = buildApp({
      role: "all",
      db: rt.db,
      enqueue: rt.enqueue,
      // No startup step on Workers: /claim is open while no user exists and
      // checks tokens minted by the deploy CLI (`claros claim-url`).
      claimFromDatabase: true,
      staticFallback: assets ? () => assetsFallback(assets) : undefined,
    });
  }
  return rt.app;
}

/**
 * The dashboard from the Static Assets binding, with the Node rules: hashed
 * files under assets/ are cached for a year, everything else is no-store,
 * unknown non-API GET/HEAD paths get index.html. Requests for files that exist
 * are normally answered by the platform before the Worker runs; this covers
 * the rest (and `wrangler dev` with the same configuration).
 */
function assetsFallback(assets: Fetcher): StaticFallback {
  const withCacheHeader = (res: Response, pathname: string): Response => {
    const out = new Response(res.body, res);
    out.headers.set(
      "cache-control",
      pathname.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
    );
    return out;
  };
  return spaFallback({
    file: async (pathname, c) => {
      const res = await assets.fetch(new Request(c.req.url, { method: c.req.method }));
      return res.ok ? withCacheHeader(res, pathname) : null;
    },
    index: async (c) => {
      const res = await assets.fetch(new Request(new URL("/index.html", c.req.url), { method: c.req.method }));
      return withCacheHeader(res, "/index.html");
    },
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    syncProcessEnv(env);
    return (await app(env)).fetch(request);
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    syncProcessEnv(env);
    if (batch.queue.endsWith("-dlq")) return consumeDeadJobs(batch);
    const rt = runtime(env);
    return consumeJobs(batch, { db: rt.db, enqueue: rt.enqueue });
  },

  /**
   * Periodic jobs are enqueued, not run here: each runs in its own queue
   * invocation with its own time budget and retries, and the queue consumer
   * stays the only place where jobs run.
   */
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    syncProcessEnv(env);
    const due = dueTicks(new Date(controller.scheduledTime));
    await env.JOBS.sendBatch(due.map((name) => ({ body: { name, data: {} } })));
  },
};
