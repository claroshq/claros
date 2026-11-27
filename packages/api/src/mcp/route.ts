/**
 * POST /v1/mcp: the MCP endpoint (Streamable HTTP, stateless, JSON
 * responses). Same code on Node + Postgres and Workers + D1.
 *
 * Auth: `Authorization: Bearer clr_ak_...` only. The product comes from the
 * key; X-Claros-Product and ?product= are ignored and session cookies do not
 * authenticate here (the route does not read the session tenant), so a
 * browser page cannot drive it with a signed-in operator's cookie.
 * Ingestion keys, instance keys and a missing or revoked key answer 401.
 *
 * GET and DELETE answer 405: there are no server-sent event streams and no
 * sessions to end. A request from a browser page on another origin answers
 * 403 (the spec's DNS rebinding protection).
 *
 * One log line per request: method, tool, product, key id, outcome and
 * duration. Never arguments, message content, addresses or keys.
 */
import { createRouter } from "../http/router.js";
import { authenticateAdminKeyOnly } from "../http/admin-auth.js";
import type { AppContext } from "../http/env.js";
import { asRequest, handleRequest, ERR, PROTOCOL_VERSIONS, type CallRecord } from "./protocol.js";

/** Requests are small JSON-RPC objects; the largest is an edit with a 50,000 character body. */
const MAX_BODY_BYTES = 256 * 1024;

function rpcError(c: AppContext, status: 200 | 400, code: number, message: string): Response {
  return c.json({ jsonrpc: "2.0", id: null, error: { code, message } }, status);
}

function sameOrigin(c: AppContext): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
}

export default function mcpRoutes() {
  const app = createRouter();

  app.post("/", async (c) => {
    const started = Date.now();
    if (!sameOrigin(c)) return c.json({ error: "Cross-origin requests are not allowed." }, 403);

    const auth = await authenticateAdminKeyOnly(c);
    if (!auth) {
      c.header("WWW-Authenticate", 'Bearer realm="claros", error="invalid_token"');
      return c.json({ error: "Authentication required: Authorization: Bearer clr_ak_... (a product admin key)." }, 401);
    }

    const version = c.req.header("mcp-protocol-version");
    if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      return rpcError(c, 400, ERR.INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${version.slice(0, 40)}`);
    }

    const type = c.req.header("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/json")) {
      return c.json({ error: "Content-Type must be application/json." }, 415);
    }
    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) return c.json({ error: "Request body too large." }, 413);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return rpcError(c, 400, ERR.PARSE, "Parse error: the body is not JSON.");
    }
    if (Array.isArray(body)) return rpcError(c, 400, ERR.INVALID_REQUEST, "Batch requests are not supported.");
    const req = asRequest(body);
    if (!req) return rpcError(c, 400, ERR.INVALID_REQUEST, "Invalid JSON-RPC 2.0 request.");

    const record: CallRecord = { method: req.method, outcome: "error" };
    let status = 200;
    try {
      const res = await handleRequest(
        req,
        {
          db: c.var.db,
          tenant: auth.tenant,
          enqueue: c.var.enqueue,
          scopes: auth.scopes,
          serverVersion: process.env.CLAROS_VERSION ?? "dev",
        },
        record,
      );
      if (res === null) {
        status = 202;
        return c.body(null, 202);
      }
      return c.json(res);
    } catch (err) {
      record.outcome = "internal_error";
      c.var.log.error({ event: "mcp_error", tool: record.tool, err: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
      return c.json({ jsonrpc: "2.0", id: req.id ?? null, error: { code: ERR.INTERNAL, message: "Internal error." } });
    } finally {
      c.var.log.info({
        event: "mcp_call",
        mcp_method: record.method.slice(0, 60),
        ...(record.tool ? { tool: record.tool } : {}),
        ...(record.client ? { client: record.client } : {}),
        product: auth.tenant.slug,
        key_id: auth.tenant.apiKeyId,
        outcome: record.outcome,
        status,
        duration_ms: Date.now() - started,
      });
    }
  });

  const notAllowed = (c: AppContext) => {
    c.header("Allow", "POST");
    return c.json({ error: "Method not allowed: this MCP endpoint takes POST only (no event streams, no sessions)." }, 405);
  };
  app.get("/", notAllowed);
  app.delete("/", notAllowed);

  return app;
}
