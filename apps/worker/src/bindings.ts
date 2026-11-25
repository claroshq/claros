/**
 * The Worker's bindings and the subset of the Workers runtime types this
 * entry uses. Declared here instead of pulling in @cloudflare/workers-types
 * (not an approved dependency); `wrangler types` can generate the full set.
 */

/** A D1 database binding; only handed to drizzle-orm/d1. */
export type D1Database = object;

/** Body of every message on the JOBS queue. */
export interface JobMessage {
  /** Queue name from QUEUE in @claros/core. */
  name: string;
  /** Job payload. */
  data: Record<string, unknown>;
  /** Base retry delay in seconds (pg-boss retryDelay), when the sender set one. */
  retryDelay?: number;
}

export interface Queue<Body> {
  send(body: Body, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Iterable<{ body: Body; delaySeconds?: number }>): Promise<void>;
}

export interface Message<Body> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatch<Body> {
  readonly queue: string;
  readonly messages: readonly Message<Body>[];
}

export interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Fetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

/** Bindings from wrangler.jsonc. String vars and secrets also appear in process.env (nodejs_compat). */
export interface Env {
  DB: D1Database;
  JOBS: Queue<JobMessage>;
  /** Static Assets (the built dashboard); absent when no assets are configured. */
  ASSETS?: Fetcher;
  BASE_URL?: string;
  DASHBOARD_URL?: string;
  ENCRYPTION_KEY?: string;
  UNSUBSCRIBE_SIGNING_KEY?: string;
}
