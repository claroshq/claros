/**
 * CORS handling for the ingestion scope.
 *
 * Why this configuration is safe:
 * - Ingestion authenticates with a token in the request (Authorization header
 *   or body field), never with cookies. Access-Control-Allow-Credentials is
 *   never emitted, so no ambient browser authority (session cookies) can be
 *   attached cross-origin. The session-cookie dashboard scope is entirely
 *   unaffected: these headers exist only inside the /v1/track + /v1/identify
 *   encapsulated scope.
 * - The worst case a permissive ACAO enables here is "a page the user visits
 *   can write events with a key it already possesses." That is the defined
 *   capability of a publishable key. No key-authenticated endpoint can read
 *   tenant data, so there is nothing to exfiltrate.
 *
 * Preflight policy: OPTIONS is answered permissively (echo Origin, allow
 * POST + authorization/content-type headers) because a preflight carries no
 * key and therefore cannot be validated against a key's origin allowlist.
 * Enforcement happens on the actual request: the auth hook rejects
 * disallowed origins with 403 and no ACAO header, so the browser blocks it.
 *
 * Simple-request design: the browser snippet posts with
 * Content-Type: text/plain (a CORS-safelisted value) and the key in the
 * body, so the common case is a simple request with no preflight at all and
 * works through navigator.sendBeacon on page unload. The text/plain parser
 * registered here (scope-local) parses the body as JSON. The
 * Authorization-header + application/json path remains fully supported for
 * server-side clients; it simply costs one preflight per origin.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

/**
 * Register CORS support on the encapsulated ingestion scope.
 * Must be registered inside the same scope as the ingest routes so the
 * onSend hook and the OPTIONS routes apply only to ingestion.
 */
export function registerIngestCorsPlugin(app: FastifyInstance): void {
  // The browser beacon path posts JSON as text/plain to stay a CORS-simple
  // request. Parse it as JSON inside this scope only; the rest of the API
  // keeps its default content-type handling.
  app.addContentTypeParser(
    "text/plain",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(null, undefined);
      }
    },
  );

  // Preflight. No credentials arrive on OPTIONS, so there is nothing to
  // authenticate; actual-request enforcement lives in the auth hook.
  const preflightHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (origin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
    }
    reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "authorization, content-type");
    reply.header("Access-Control-Max-Age", "86400");
    return reply.status(204).send();
  };
  app.options("/track", preflightHandler);
  app.options("/identify", preflightHandler);
  app.options("/batch", preflightHandler);

  // Actual responses: echo the Origin only when the auth hook approved it
  // (publishable key + allowlist pass). Secret-key browser requests and
  // denied origins deliberately get no ACAO, so the browser blocks them.
  app.addHook("onSend", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    const corsOrigin = request.ingestTenant?.corsOrigin;
    if (corsOrigin && !reply.hasHeader("Access-Control-Allow-Origin")) {
      reply.header("Access-Control-Allow-Origin", corsOrigin);
      reply.header("Vary", "Origin");
    }
  });
}
