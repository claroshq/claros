# MCP server

> Since v0.9.0. Same behaviour on Postgres + Node and on Cloudflare Workers + D1.

Claros serves a [Model Context Protocol](https://modelcontextprotocol.io) endpoint, so you can work a product's approval queue and look up contacts and flows from an MCP client such as Claude Code or Claude Desktop, without opening the dashboard:

- "Anything waiting in Claros?" answers with one call (`queue_summary`).
- "Show me the dunning drafts" lists the queue with each draft's flow, subject, preview and the reasoning behind it.
- "Approve the three trial-ending drafts, but change the subject of the second one first" edits and approves.
- "What has u_42 received from us this month?" reads the contact's timeline.

The endpoint is part of the HTTP API you already run. There is nothing extra to install or deploy on the server.

## What it can and cannot do

MCP actions go through the same code as the dashboard and the HTTP API:

- **Approving does not send sooner.** An approved message goes to `approved` and is sent by the normal drain, which still applies the send window, throttle, suppression and consent checks. Nothing an MCP call does sends mail sooner than the dashboard would.
- **Every action is recorded like other admin key actions.** Approvals, rejections, cancellations and edits store `api_key:<key id>` in `approved_by`, `rejected_by` and `edited_by`, as the [API keys](API_KEYS.md) page describes. Each call also writes one log line (see [Logging](#logging)).
- **The LLM does not run in the MCP server.** `regenerate_message` sends a draft back to `pending_generation`; the content worker drafts it later, exactly as with the **Regenerate** button.
- **Nothing is sent, configured or deleted** beyond the actions in the [tool list](#tools). See [Not exposed](#not-exposed).

## 1. Create an admin key

MCP uses a product [admin key](API_KEYS.md#admin-keys) (`clr_ak_...`). The key decides the product and what the client can see and do: `tools/list` returns only the tools the key's scopes allow.

| Scope | Tools it enables |
|---|---|
| `messages` | `queue_summary`, `list_pending_approvals`, `get_message`, `approve_messages`, `reject_messages`, `edit_message`, `regenerate_message`, `cancel_message`, `unapprove_message`, `exclude_contact` |
| `contacts:read` | `get_contact`, `get_contact_timeline` |
| `config` | `list_flows`, `pause_flow`, `resume_flow` |

For daily review, `messages` and `contacts:read` are enough. Add `config` only if the person may also pause and resume flows (the `config` scope also allows `PUT /v1/config` over the HTTP API, so give it deliberately).

A product owner creates the key in the dashboard (**Integrate**, **Admin key**, pick the scopes) or with the API:

```bash
curl -X POST https://claros.example.com/v1/ingestion/keys \
  -H "Cookie: claros_session=..." -H "Content-Type: application/json" \
  -d '{"kind": "admin", "label": "MCP: approvals", "scopes": ["messages", "contacts:read"]}'
# {"key": "clr_ak_...", "kind": "admin", "scopes": ["messages", "contacts:read"], ...}
```

The key is shown once. Treat it like a password: anyone with it can approve mail for the product. Revoke it on the same page; revocation applies to the next request.

One key acts on one product. To review several products, add one MCP server per product, each with its own key and name.

## 2. Connect a client

The endpoint is `https://<your Claros host>/v1/mcp` (Streamable HTTP). The client sends the key as `Authorization: Bearer clr_ak_...`.

### Claude Code

```bash
claude mcp add --transport http claros https://claros.example.com/v1/mcp \
  --header "Authorization: Bearer clr_ak_..."
```

Add `--scope user` to make it available in every project, or `--scope project` to share the server entry with your team through `.mcp.json` (then keep the key out of the file: use `"Authorization": "Bearer ${CLAROS_ADMIN_KEY}"` there and set the variable in each person's environment). Check the connection with `claude mcp get claros` or `/mcp` inside a session.

### Claude Desktop

Claude Desktop starts local servers from its config file (**Settings**, **Developer**, **Edit Config**). Use the `mcp-remote` bridge to reach a remote server with a header:

```json
{
  "mcpServers": {
    "claros": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://claros.example.com/v1/mcp", "--header", "Authorization:${CLAROS_AUTH}"],
      "env": { "CLAROS_AUTH": "Bearer clr_ak_..." }
    }
  }
}
```

Restart Claude Desktop afterwards. The header is passed through an environment variable because some platforms split arguments at spaces.

### Other clients

Any MCP client that supports the Streamable HTTP transport and a custom `Authorization` header works the same way. claude.ai custom connectors need OAuth, which Claros does not offer yet (see [Later](#later)).

### Check the connection

From a checkout of the repository, `scripts/mcp-smoke.mjs` runs the handshake a client makes (initialize, tools/list, one read-only tool) and changes nothing:

```bash
CLAROS_ADMIN_KEY=clr_ak_... node scripts/mcp-smoke.mjs https://claros.example.com
```

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) works too:

```bash
npx @modelcontextprotocol/inspector --cli https://claros.example.com/v1/mcp \
  --transport http --header "Authorization: Bearer clr_ak_..." --method tools/list
```

## Tools

Read tools have `readOnlyHint: true`. Lists default to 20 items and take `limit` (at most 50) and the `cursor` from the previous answer's `next_cursor`.

| Tool | Scope | Input | What it returns |
|---|---|---|---|
| `queue_summary` | messages | none | Counts for messages that are not final: `pending_approval`, `critical_pending`, `oldest_pending_at`, `approved_not_sent`, `waiting_for_draft`, `waiting_for_llm_budget`, and over the last 7 days `value_gated_last_7_days` and `failed_generation_last_7_days` |
| `list_pending_approvals` | messages | `limit?`, `cursor?` | The approval queue, critical-class flows first, then oldest first: id, flow name and class, step, action type, subject, a 280-character preview of the body, the brain's reasoning, the contact's email, name and external id |
| `get_message` | messages | `id` | One message in full: status, subject, body as text, AI opening line, reasoning, the `choose` decision, the drafted version when edited (`original`), and the last approval, rejection (or cancellation) and edit with who did it |
| `get_contact` | contacts:read | exactly one of `id`, `external_id`, `email` | The contact (traits, lifecycle state, dates), the suppression of its address if any, topic statuses, flow memberships |
| `get_contact_timeline` | contacts:read | `contact` (id or external id), `limit?`, `cursor?` | Events, lifecycle transitions and messages, newest first. Request context (IP address, user agent) is left out |
| `list_flows` | config | `include_archived?` | Flows with status, class, approval mode, content mode, compile status, and per flow `pending_approval` and `approved_not_sent` |
| `approve_messages` | messages | `ids` (1 to 100) | Each id's outcome. Approved messages are sent by the normal drain |
| `reject_messages` | messages | `ids` (1 to 100) | Each id's outcome. Final: a rejected message is never sent |
| `edit_message` | messages | `id`, `subject?` (up to 300 characters), `body_markdown?` (up to 50,000), at least one | The message stays `pending_approval`; the drafted subject and body are kept |
| `regenerate_message` | messages | `id`, `action_type?` | Back to `pending_generation` for a new draft; with `action_type` the brain drafts that action |
| `cancel_message` | messages | `id` | An approved, unsent message becomes `cancelled` (final) |
| `unapprove_message` | messages | `id` | An approved, unsent message goes back to the queue |
| `exclude_contact` | messages | `contact` (id or external id) | A manual suppression of the address and every unsent message of the person cancelled, in one step |
| `pause_flow`, `resume_flow` | config | `flow` (id or slug) | The flow and its new status; the [flow status rules](API_KEYS.md#scopes) apply (a draft cannot be paused, resuming needs a compiled plan) |

The write tools have `readOnlyHint: false`; `reject_messages`, `cancel_message` and `exclude_contact` also have `destructiveHint: true`, so clients that ask before destructive actions do so for them.

### Outcomes

Every action is a compare-and-swap on the message's current status, as in the dashboard. Each message gets one of these outcomes:

| Outcome | Meaning |
|---|---|
| `done` | This call made the change |
| `unchanged` | The message was already in the target status (approving an approved message, cancelling a cancelled one) |
| `conflict` | The message moved on (someone else acted, or it was sent); its current `status` is given and nothing changed |
| `not_found` | No such message in this product |

```json
{
  "approved": 1,
  "results": [
    { "id": "6f1c...", "outcome": "done", "status": "approved" },
    { "id": "a93e...", "outcome": "conflict", "status": "sent", "message": "The message is 'sent' now; it already moved on, nothing was changed." }
  ]
}
```

`approve_messages` and `reject_messages` report a mix of outcomes as a normal result. The single-message tools return `conflict` and `not_found` as tool errors (`isError: true`) with the same JSON, so the model sees what happened and does not retry blindly. Invalid input (a missing field, a limit over 50) is also a tool error that names the field.

On an [archived product](PRODUCTS.md#archiving) the read tools work and the write tools answer "Product is archived".

## Security

- **Admin keys only.** The endpoint authenticates with `Authorization: Bearer clr_ak_...` and nothing else. Dashboard session cookies, ingestion keys (`clr_pk_`, `clr_sk_`) and instance keys (`clr_ik_`) answer `401`. A browser page therefore cannot use a signed-in operator's session to call it.
- **One product per key.** The product comes from the key. `X-Claros-Product` and `?product=` are ignored, and a key never reads or changes another product's data.
- **Scopes checked twice.** `tools/list` shows only the tools the key's scopes allow, and `tools/call` checks the scope again (JSON-RPC error `-32003` when it is missing).
- **Origin check.** A request with an `Origin` header for another host answers `403`, which protects local and private installs against DNS rebinding.

## Logging

Each request writes one JSON log line with `event: "mcp_call"`, the JSON-RPC method, the tool name, the client name (from `initialize`), the product slug, the key id, the outcome, the HTTP status and the duration:

```json
{"level":30,"event":"mcp_call","mcp_method":"tools/call","tool":"approve_messages","product":"acme","key_id":"3b0c...","outcome":"approved:3/3","status":200,"duration_ms":41}
```

Arguments, message content, email addresses and keys are never logged.

## Protocol details

- Transport: Streamable HTTP, stateless. `POST /v1/mcp` takes one JSON-RPC 2.0 request and answers with one JSON response (`Content-Type: application/json`). There are no event streams and no sessions: `GET` and `DELETE` answer `405`.
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications (requests without `id`, such as `notifications/initialized`) answer `202` with no body. Other methods answer `-32601`; batches (JSON arrays) answer `-32600`.
- Protocol versions: `2025-11-25`, `2025-06-18` and `2025-03-26`. `initialize` answers with the client's version when it is one of these, else `2025-11-25`. A request with an unsupported `MCP-Protocol-Version` header answers `400`.
- Tool results carry the JSON both as text (`content`) and as `structuredContent`.
- `GET /v1/capabilities` lists the feature id `mcp`.

## Not exposed

These are deliberately not tools. Use the dashboard or the HTTP API for them:

- Sending or test-sending any email
- Creating or editing flows, prompts, templates, transports and routing, and `PUT /v1/config`
- Ingesting or importing events and history
- Deleting or erasing contacts, deleting suppressions (to undo `exclude_contact`, remove the suppression in the dashboard or with `DELETE /v1/suppressions/:email`)
- Managing keys, and anything an instance key does

## Later

Not built yet:

- OAuth 2.1, so claude.ai custom connectors can connect with a per-person login and the person's product role instead of a shared admin key, and actions are attributed to that person.
- A tool for the retention grid's cells and the contacts in them.
- Telling a connected client that drafts are waiting. Today, use the `message.pending_approval` [webhook](WEBHOOKS.md) or the daily digest (`settings.approvals.daily_digest`, see [Approvals](APPROVALS.md#reaching-reviewers-v08)).
- Recording who regenerated, unapproved or excluded, and who paused or resumed a flow, on the record itself. These actions have no actor column today; the MCP log line records the key.
