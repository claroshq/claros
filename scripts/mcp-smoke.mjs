#!/usr/bin/env node
// MCP smoke test: the handshake a client makes, against a running Claros.
//
//   CLAROS_ADMIN_KEY=clr_ak_... node scripts/mcp-smoke.mjs http://localhost:3000
//
// Runs initialize, notifications/initialized, tools/list and one read tool
// (queue_summary when the key has the messages scope, else the first
// read-only tool without required inputs). Exits 1 on the first failure.
// Read-only: it calls no tool that changes data.

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
const key = process.env.CLAROS_ADMIN_KEY;
if (!key) {
  console.error("Set CLAROS_ADMIN_KEY to a product admin key (clr_ak_...).");
  process.exit(1);
}

const url = `${base}/v1/mcp`;
const headers = {
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
let nextId = 1;

async function send(method, params, notification = false) {
  const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(notification ? {} : { id: nextId++ }) };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (notification) {
    if (res.status !== 202) throw new Error(`${method}: expected 202, got ${res.status}`);
    return null;
  }
  if (res.status !== 200) throw new Error(`${method}: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.code} ${json.error.message}`);
  return json.result;
}

try {
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claros-mcp-smoke", version: "1" },
  });
  console.log(`initialize: ${init.serverInfo.name} ${init.serverInfo.version}, protocol ${init.protocolVersion}`);
  await send("notifications/initialized", undefined, true);
  console.log("notifications/initialized: 202");
  const { tools } = await send("tools/list");
  console.log(`tools/list: ${tools.map((t) => t.name).join(", ") || "(none: the key has no scope with tools)"}`);
  const read =
    tools.find((t) => t.name === "queue_summary") ??
    tools.find((t) => t.annotations?.readOnlyHint && !(t.inputSchema.required ?? []).length);
  if (read) {
    const result = await send("tools/call", { name: read.name, arguments: {} });
    if (result.isError) throw new Error(`${read.name}: ${result.content[0].text}`);
    console.log(`tools/call ${read.name}: ${result.content[0].text.slice(0, 300)}`);
  }
  console.log("MCP smoke test passed.");
} catch (err) {
  console.error(`MCP smoke test failed: ${err.message}`);
  process.exit(1);
}
