/**
 * MCP setup helpers shared by the Connect your AI page and the home card.
 *
 * Claros cannot tell an MCP call from another admin key call after the fact
 * (both update the key's last_used_at), so the state is about keys that can
 * work the approval queue, never "connected".
 */
import type { IngestKey } from "../../api.js";

/** The scopes the MCP tools need for daily review (docs/guide/MCP.md). */
export const MCP_SCOPES = ["messages", "contacts:read"] as const;

export type McpKeyState =
  | { kind: "none" }
  | { kind: "ready"; keys: IngestKey[] }
  | { kind: "used"; keys: IngestKey[]; lastUsedAt: string };

/** Live admin keys with the `messages` scope: the ones an MCP client can review with. */
export function mcpKeys(keys: IngestKey[]): IngestKey[] {
  return keys.filter(
    (k) => k.kind === "admin" && k.revoked_at === null && (k.scopes ?? []).includes("messages"),
  );
}

export function mcpKeyState(keys: IngestKey[]): McpKeyState {
  const usable = mcpKeys(keys);
  if (usable.length === 0) return { kind: "none" };
  const lastUsedAt = usable
    .map((k) => k.last_used_at)
    .filter((t): t is string => t !== null)
    .sort()
    .pop();
  return lastUsedAt ? { kind: "used", keys: usable, lastUsedAt } : { kind: "ready", keys: usable };
}

export type ClientId = "claude-code" | "claude-desktop" | "cursor" | "vscode" | "other";

export interface ClientSetup {
  id: ClientId;
  name: string;
  where: string;
  /** Where the snippet goes, one short line. */
  intro: string;
  /** The snippet, with the endpoint and the key (or a placeholder) filled in. */
  snippet: (endpoint: string, key: string) => string;
  /** What to do after pasting it. */
  after: string;
}

export const CLIENTS: ClientSetup[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    where: "Terminal",
    intro: "Run this once in a terminal.",
    snippet: (endpoint, key) =>
      `claude mcp add --transport http claros ${endpoint} \\\n  --header "Authorization: Bearer ${key}"`,
    after:
      "Add --scope user to use it in every project. Check it with `claude mcp get claros` or /mcp inside a session.",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    where: "Mac and Windows app",
    intro: "Settings, Developer, Edit Config, then add this to claude_desktop_config.json.",
    snippet: (endpoint, key) =>
      JSON.stringify(
        {
          mcpServers: {
            claros: {
              command: "npx",
              args: ["-y", "mcp-remote", endpoint, "--header", "Authorization:${CLAROS_AUTH}"],
              env: { CLAROS_AUTH: `Bearer ${key}` },
            },
          },
        },
        null,
        2,
      ),
    after:
      "Restart Claude Desktop. The mcp-remote bridge needs Node.js; the header goes through an environment variable because some platforms split arguments at spaces.",
  },
  {
    id: "cursor",
    name: "Cursor",
    where: "Editor",
    intro: "Add this to ~/.cursor/mcp.json, or .cursor/mcp.json in a project.",
    snippet: (endpoint, key) =>
      JSON.stringify(
        { mcpServers: { claros: { url: endpoint, headers: { Authorization: `Bearer ${key}` } } } },
        null,
        2,
      ),
    after: "Cursor picks the server up from Settings, MCP. Keep the key out of files you commit.",
  },
  {
    id: "vscode",
    name: "VS Code",
    where: "Copilot agent mode",
    intro: "Add this to .vscode/mcp.json, or run MCP: Add Server.",
    snippet: (endpoint, key) =>
      JSON.stringify(
        { servers: { claros: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${key}` } } } },
        null,
        2,
      ),
    after: "Start the server from the file or the MCP view. Keep the key out of files you commit.",
  },
  {
    id: "other",
    name: "Other clients",
    where: "Streamable HTTP",
    intro: "Any MCP client with the Streamable HTTP transport and a custom header works.",
    snippet: (endpoint, key) => `URL     ${endpoint}\nHeader  Authorization: Bearer ${key}`,
    after:
      "claude.ai custom connectors need OAuth, which Claros does not offer yet; use Claude Code or Claude Desktop there.",
  },
];

/** Prompts that map onto the released tools; each says which scope it needs. */
export const PROMPTS: Array<{ text: string; uses: string; scope: string }> = [
  { text: "Anything waiting in Claros?", uses: "queue_summary", scope: "messages" },
  {
    text: "Show me the drafts waiting for approval, critical ones first, with the reasoning behind each.",
    uses: "list_pending_approvals",
    scope: "messages",
  },
  {
    text: "Approve the trial-ending drafts, but make the subject of the second one shorter first.",
    uses: "edit_message, approve_messages",
    scope: "messages",
  },
  {
    text: "Rewrite the newest draft to be warmer and mention the annual plan, then show it to me again.",
    uses: "regenerate_message",
    scope: "messages",
  },
  {
    text: "What has jane@example.com received from us this month, and what did they do after?",
    uses: "get_contact_timeline",
    scope: "contacts:read",
  },
  { text: "Pause the win-back flow, I want to rework it.", uses: "pause_flow", scope: "config" },
];
