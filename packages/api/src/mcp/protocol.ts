/**
 * The MCP protocol subset Claros serves: JSON-RPC 2.0 over Streamable HTTP,
 * stateless, one JSON response per POST (no SSE streams, no sessions).
 *
 * Methods: initialize, ping, tools/list, tools/call; notifications (no id)
 * are accepted with 202 and no body. Batches (JSON arrays) are not part of
 * the protocol since 2025-06-18 and are refused.
 */
import type { ServiceContext } from "../services/messages.js";
import { toolJson, toolsFor, TOOLS, type ToolDef } from "./tools.js";

/** Newest first; initialize answers with the client's version when it is listed, else the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

export const INSTRUCTIONS = `Claros is a lifecycle email engine. This server works one product's approval queue: AI-drafted emails wait for a person to approve, edit or reject them before they are sent.
- Start with queue_summary, then list_pending_approvals; get_message shows a draft in full.
- Approving does not send right away: approved messages go out through the normal send path (send window, throttle, suppression), as from the dashboard.
- Rejecting, cancelling and exclude_contact cannot be undone for the messages they touch. Confirm with the user before using them on many messages.
- A "conflict" outcome means the message already moved on (someone else acted, or it was sent); its current status is given. Do not retry it.
- Nothing here sends test mail, changes flows or prompts, or deletes data.`;

export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** The key's scopes do not allow the tool (the HTTP 403 of the other admin key routes). */
  FORBIDDEN: -32003,
} as const;

type Id = string | number | null;

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}

export type RpcResponse =
  | { jsonrpc: "2.0"; id: Id; result: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string } };

export interface CallContext extends ServiceContext {
  scopes: readonly string[];
  serverVersion: string;
}

/** What happened, for the log line: method, tool, outcome. Never arguments. */
export interface CallRecord {
  method: string;
  tool?: string;
  outcome: string;
  client?: string;
}

const error = (id: Id, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

/** A JSON-RPC request object, or null when the value is not one. */
export function asRequest(body: unknown): RpcRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.jsonrpc !== "2.0" || typeof b.method !== "string") return null;
  if (b.id !== undefined && b.id !== null && typeof b.id !== "string" && typeof b.id !== "number") return null;
  if (b.params !== undefined && (b.params === null || typeof b.params !== "object" || Array.isArray(b.params))) return null;
  return b as unknown as RpcRequest;
}

/**
 * Handle one request. Returns the response, or null for a notification
 * (the transport answers 202). `record` is filled for the log line.
 */
export async function handleRequest(req: RpcRequest, ctx: CallContext, record: CallRecord): Promise<RpcResponse | null> {
  record.method = req.method;
  const isNotification = req.id === undefined;
  const id: Id = req.id ?? null;
  const params = req.params ?? {};

  if (isNotification) {
    record.outcome = "notification";
    return null;
  }

  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      const info = params.clientInfo as { name?: unknown } | undefined;
      if (typeof info?.name === "string") record.client = info.name.slice(0, 80);
      record.outcome = "ok";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "claros", title: "Claros", version: ctx.serverVersion },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      record.outcome = "ok";
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      record.outcome = "ok";
      return { jsonrpc: "2.0", id, result: { tools: toolsFor(ctx.scopes).map(toolJson) } };
    case "tools/call":
      return callTool(id, params, ctx, record);
    default:
      record.outcome = "method_not_found";
      return error(id, ERR.METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}

async function callTool(id: Id, params: Record<string, unknown>, ctx: CallContext, record: CallRecord): Promise<RpcResponse> {
  const name = params.name;
  if (typeof name !== "string") {
    record.outcome = "invalid_params";
    return error(id, ERR.INVALID_PARAMS, "params.name must be a tool name.");
  }
  record.tool = name.slice(0, 80);
  const tool: ToolDef | undefined = TOOLS.find((t) => t.name === name);
  if (!tool) {
    record.outcome = "unknown_tool";
    return error(id, ERR.INVALID_PARAMS, `Unknown tool: ${name}`);
  }
  if (!ctx.scopes.includes(tool.scope)) {
    record.outcome = "forbidden";
    return error(id, ERR.FORBIDDEN, `Forbidden: this key lacks the '${tool.scope}' scope.`);
  }
  const args = params.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    record.outcome = "invalid_params";
    return error(id, ERR.INVALID_PARAMS, "params.arguments must be an object.");
  }
  // Input errors are tool results, so the model can correct the call.
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) {
    record.outcome = "invalid_arguments";
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return toolResult(id, { error: `Invalid arguments: ${where}${issue?.message ?? "invalid input"}` }, true);
  }
  if (tool.write && ctx.tenant.archived) {
    record.outcome = "archived";
    return toolResult(id, { error: "Product is archived. It is read-only until it is unarchived." }, true);
  }
  const out = await tool.run(ctx, parsed.data as Record<string, unknown>);
  record.outcome = out.outcome;
  return toolResult(id, out.body, out.isError === true);
}

function toolResult(id: Id, body: Record<string, unknown>, isError: boolean): RpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
      ...(isError ? { isError: true } : {}),
    },
  };
}
