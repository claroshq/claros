# Approvals

> The approval queue, approve, reject and retry are in every release. Everything marked (v0.8) below is available since v0.8.

Messages of flows with approval mode `require` wait in the queue (status `pending_approval`) until someone approves or rejects them. Flows with approval mode `auto` skip the queue.

## The queue

`GET /v1/messages` lists the queue (or another status with `?status=`), critical-class flows first (v0.8), then oldest first. `GET /v1/messages/:id` (unreleased) returns one message in any status, in the same shape. Each message carries the flow name and class, the action type, the brain's reasoning, who approved, rejected or edited it, and, when it was edited, the content as drafted (`original`).

## Actions

| Action | Request | From | To |
|---|---|---|---|
| Approve | `POST /v1/messages/:id/approve` (bulk: `/bulk/approve`) | `pending_approval` | `approved` |
| Reject | `POST /v1/messages/:id/reject` (bulk: `/bulk/reject`) | `pending_approval` | `rejected` |
| Edit (v0.8) | `PATCH /v1/messages/:id` `{"subject": "...", "body_markdown": "..."}` | `pending_approval` | unchanged; the drafted version is kept |
| Regenerate (v0.8) | `POST /v1/messages/:id/regenerate` `{"action_type": "..."}` (optional) | `pending_approval` | `pending_generation` |
| Revise (unreleased) | `POST /v1/messages/:id/regenerate` `{"instruction": "..."}` | `pending_approval` | `pending_generation`, then back to `pending_approval` |
| Cancel (v0.8) | `POST /v1/messages/:id/cancel` | `approved` | `cancelled` |
| Back to review (v0.8) | `POST /v1/messages/:id/unapprove` | `approved` | `pending_approval` |
| Exclude person (v0.8) | `POST /v1/contacts/:id/exclude` | every unsent message of the person | `cancelled` |
| Retry generation | `POST /v1/messages/:id/retry` | `failed` (generation) | `pending_generation` |

Every transition is a compare-and-swap on the current status: when the message already moved on (another reviewer, the drain), the action answers `409` with the current status and changes nothing. Approving an approved message and cancelling a cancelled one answer `200`.

- **Edit** renders the Markdown body to HTML and text like a drafted body. The first edit keeps the drafted subject and body in `original_subject`, `original_body_html` and `original_body_text`; `edited_by` and `edited_at` record the last edit.
- **Regenerate** sends the message back for a new draft. With `action_type`, the brain drafts that action and skips its decide step (the reviewer took that decision); the value gate still runs.
- **Revise** (unreleased) asks the AI to rewrite the current draft with your feedback, for example `{"instruction": "There is no /mcp page, link to the docs instead."}` (at most 2,000 characters). The content worker gets the previous subject and body plus the instruction, under the product's usual drafting rules (named links and the link allowlist, writing rules, knowledge base, context data, language). It keeps the action the draft was written for, skips the decide step and the value gate (a reviewer asked for it and reviews it), and puts the revised draft back in the queue. The checks after drafting still apply: a revised draft with a link that is not allowed is blocked like any other draft. Each instruction is kept on the message in `revisions` (`[{"instruction", "by", "at"}]`, oldest first); `revision_request` holds the one being applied and is cleared when the revised draft is written. A step that renders a template is re-rendered, not revised; edit the draft or the template instead.
- **Exclude person** adds a manual suppression of the person's address and cancels every message not handed to the drain yet (`pending_generation`, `generating`, `awaiting_content`, `pending_approval`, `approved`), in one atomic step. A message already `sending` is left to the drain (the suppression check before the send stops it when it has not left yet). Undo with `DELETE /v1/suppressions/:email`; cancelled messages stay cancelled. The person's page (People) has the same action under **Actions**, **Exclude from mail**.

The dashboard Approvals screen offers all of these. The queue is on the left and the draft under review on the right, each scrolling on its own; the toolbar above the draft holds **Approve**, **Reject**, **Edit**, **Revise** and **More**, and beside the preview (below it on narrow screens) is what the AI based the draft on: why it wrote it, the choose step, details, the drafted version and the context data. **Revise with AI** opens under the toolbar and is a conversation with the drafter: type what should change and press Enter; the draft stays on screen, marked as revising, until the revised one arrives, and the thread shows every instruction given for that draft. **More** holds redraft from scratch (optionally as another action type) and exclude person. After approve or reject the next draft opens, and the decision can be undone for five seconds (**Undo** or `z`): it reaches the server only when that window closes, or at once when you leave the page. The recipient's name (above the draft and under Details) opens a person card when you hover or click it: name, email, company, lifecycle state, engagement and payment status, first and last seen, suppression, the flows they are in, the team's latest notes, a few properties and their most recent timeline (events, state changes and mail, with the draft under review marked), linking to the full profile. A click or `p` keeps it open until Escape or a click elsewhere. Keyboard: `j`/`k` move through the queue, `a` approves, `r` rejects, `e` edits, `/` opens the revise box, `p` opens the person card, `z` undoes the last decision. The **Approved** tab lists approved messages that have not been sent yet, with **Back to review** and **Cancel send**; **Needs attention** lists drafts the value gate held and failed messages.

## Reaching reviewers (v0.8)

- An [admin key](API_KEYS.md) with the `messages` scope can list, approve, reject, edit, regenerate and cancel from your own tools.
- The [MCP server](MCP.md) (v0.9.0) puts the same queue in an MCP client such as Claude Code or Claude Desktop: ask what is waiting, read a draft, edit it and approve or reject it from the chat. It uses an admin key and the same compare-and-swap transitions, so a draft someone else already handled comes back as a conflict with its current status.
- The `message.pending_approval` [webhook](WEBHOOKS.md) tells you that messages are waiting. It is batched: at most one per product and endpoint per window (the endpoint's `batch_interval_minutes`, 1 to 1440, default 15), sent at the end of the window, with `pending_count`, the number of messages waiting at delivery time.
- With `settings.approvals.daily_digest: true` ([config](CONFIG.md#settings)), the product's owners get one mail a day, from 08:00 in the product's timezone (`throttle.tenant_timezone`, else UTC), saying how many drafts wait and linking to the Approvals page. It goes through the product's transactional route (no List-Unsubscribe headers) and is skipped on days nothing waits.

## Value gate and LLM budget (v0.8)

- Every AI draft passes the value gate (the assess step) before it reaches the queue. `settings.brain.assess.enabled: false` turns the gate off for the product; `settings.brain.assess.threshold` (1 to 10) asks the gate for a score as well and fails drafts that score below it (the score in the reasoning).
- What a failed gate does depends on the flow. In a flow that needs approval (`approval_mode: require`, the default), the draft still goes to the queue: `status_reason` is `value_gate: <the gate's reason>` and the dashboard shows the objection above the draft, so the reviewer decides. In a flow that sends on its own (`approval_mode: auto`), the draft is held (status `value_gated`) and listed under Needs attention on the Approvals screen. `POST /v1/messages/:id/release` sends a held draft to review (with the reason as `status_reason`); `POST /v1/messages/:id/dismiss` drops it (`cancelled`, reason `dismissed`). Before v0.15 every failed draft was held, and a held draft showed only on the person's page.
- `settings.llm_daily_token_budget` caps the LLM tokens a product uses per UTC day (every call counts: compile, decide, draft, assess, choose, opening line). Once it is spent, messages that need the LLM wait at `pending_generation` with `status_reason = llm_budget` and are drafted after midnight UTC. The Approvals page shows how many drafts wait for the budget. Fixed-content messages without an AI opening line are not affected.
