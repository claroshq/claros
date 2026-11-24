/**
 * Framework-level error responses with the same JSON shape v0.6 returned.
 *
 * v0.6 used Fastify's default error format for errors raised before a route
 * handler ran (body parsing, schema validation, unknown routes). Clients may
 * depend on it, so the shape is kept:
 *   { statusCode, code?, error, message }
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  500: "Internal Server Error",
};

export function frameworkError(
  c: Context,
  statusCode: ContentfulStatusCode,
  code: string | undefined,
  message: string,
): Response {
  const body: Record<string, unknown> = { statusCode };
  if (code) body.code = code;
  body.error = STATUS_TEXT[statusCode] ?? "Error";
  body.message = message;
  return c.json(body, statusCode);
}

/** Response for a route that does not exist (v0.6: Fastify default 404). */
export function notFound(c: Context): Response {
  const url = new URL(c.req.url);
  // Same key order as v0.6's default 404 body.
  return c.json(
    { message: `Route ${c.req.method}:${url.pathname}${url.search} not found`, error: "Not Found", statusCode: 404 },
    404,
  );
}
