import type { DrizzleD1Database } from "drizzle-orm/d1";

/** Drizzle handle on SQLite via Cloudflare D1 (or Miniflare in tests). */
export type D1Db = DrizzleD1Database<Record<string, never>>;

/**
 * Placeholder for a query module whose D1 implementation is not written yet.
 * Calling any of its methods throws, naming the area and method.
 */
export function notYetOnD1<T extends object>(area: string): T {
  return new Proxy({} as T, {
    get(_target, method) {
      if (typeof method === "symbol" || method === "then") return undefined;
      return () => {
        throw new Error(`[store] ${area}.${String(method)} is not implemented for D1 yet`);
      };
    },
  });
}
