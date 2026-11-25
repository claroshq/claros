/**
 * Request body parsing with the same rules v0.6 applied.
 *
 * v0.6 parsed bodies before the handler ran and answered parse failures with
 * framework errors. Those status codes are part of the HTTP API, so they are
 * kept exactly:
 *
 *   - GET and HEAD bodies are ignored.
 *   - DELETE and OPTIONS bodies are parsed only when non-empty.
 *   - An empty body without a Content-Type is "no body" (undefined).
 *   - application/json: empty -> 400 FST_ERR_CTP_EMPTY_JSON_BODY,
 *     invalid -> 400 with the JSON.parse error message.
 *   - text/plain: the raw string (unless a scope registers its own parser).
 *   - Any other type without a scope parser -> 415 FST_ERR_CTP_INVALID_MEDIA_TYPE.
 *   - Bodies over the limit (default 1 MiB) -> 413 FST_ERR_CTP_BODY_TOO_LARGE.
 *
 * Route scopes add parsers for their own content types (form posts, CSV
 * imports, raw JSON for webhook signatures), matching the scoped parsers v0.6
 * registered.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.js";
import { frameworkError } from "./errors.js";

/** Turns the raw body text into the value handlers see as c.var.body. */
export type BodyParser = (raw: string) => unknown;

export const DEFAULT_BODY_LIMIT = 1024 * 1024;

class EmptyJsonBody extends Error {}

function parseJson(raw: string): unknown {
  if (raw.length === 0) throw new EmptyJsonBody();
  return JSON.parse(raw);
}

const DEFAULT_PARSERS: Record<string, BodyParser> = {
  "application/json": parseJson,
  "text/plain": (raw) => raw,
};

/**
 * JSONL media types. Routes that accept JSONL (KB import, message import)
 * register these so the body reaches the handler as the raw text, the same
 * as text/plain.
 */
export const JSONL_PARSERS: Record<string, BodyParser> = {
  "application/x-ndjson": (raw) => raw,
  "application/jsonl": (raw) => raw,
  "application/x-jsonlines": (raw) => raw,
};

/**
 * Parse application/x-www-form-urlencoded the way the v0.6 auth, invite and
 * unsubscribe scopes did: "+" is a space, pairs without "=" are skipped.
 */
export function parseForm(raw: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  if (raw.length === 0) return parsed;
  for (const pair of raw.split("&")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eqIdx).replace(/\+/g, " "));
    const value = decodeURIComponent(pair.slice(eqIdx + 1).replace(/\+/g, " "));
    parsed[key] = value;
  }
  return parsed;
}

export interface BodyOptions {
  /** Extra or overriding parsers by media type (lowercase, no parameters). */
  parsers?: Record<string, BodyParser>;
  /** Maximum body size in bytes. */
  limit?: number;
}

/**
 * Middleware that parses the body into c.var.body. Register it on a scope
 * (a sub-app) to give that scope its own parsers or limit; the innermost
 * registration wins because it runs last and re-parses from the cached text.
 */
export function bodyParser(options: BodyOptions = {}): MiddlewareHandler<AppEnv> {
  const parsers = { ...DEFAULT_PARSERS, ...(options.parsers ?? {}) };
  const limit = options.limit ?? DEFAULT_BODY_LIMIT;

  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD") {
      c.set("body", undefined);
      return next();
    }

    const declaredLength = Number(c.req.header("content-length") ?? "NaN");
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      return frameworkError(c, 413, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large");
    }

    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > limit) {
      return frameworkError(c, 413, "FST_ERR_CTP_BODY_TOO_LARGE", "Request body is too large");
    }

    const contentTypeHeader = c.req.header("content-type");
    if ((method === "DELETE" || method === "OPTIONS") && raw.length === 0) {
      c.set("body", undefined);
      return next();
    }
    if (!contentTypeHeader) {
      if (raw.length === 0) {
        c.set("body", undefined);
        return next();
      }
      return frameworkError(c, 415, "FST_ERR_CTP_INVALID_MEDIA_TYPE", "Unsupported Media Type: undefined");
    }

    const mediaType = contentTypeHeader.split(";")[0]!.trim().toLowerCase();
    const parser = parsers[mediaType];
    if (!parser) {
      return frameworkError(c, 415, "FST_ERR_CTP_INVALID_MEDIA_TYPE", `Unsupported Media Type: ${mediaType}`);
    }

    try {
      c.set("body", parser(raw));
    } catch (err) {
      if (err instanceof EmptyJsonBody) {
        return frameworkError(
          c,
          400,
          "FST_ERR_CTP_EMPTY_JSON_BODY",
          "Body cannot be empty when content-type is set to 'application/json'",
        );
      }
      if (mediaType === "application/json") {
        // v0.6 answered with the JSON.parse error message and no code.
        return frameworkError(c, 400, undefined, err instanceof Error ? err.message : "Invalid JSON");
      }
      return frameworkError(c, 400, undefined, err instanceof Error ? err.message : "Invalid body");
    }
    return next();
  };
}
