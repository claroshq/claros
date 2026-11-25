# Approvals

> The approval queue, approve, reject and retry are in every release. Everything marked (v0.8) below is available since v0.8.

Messages of flows with approval mode `require` wait in the queue (status `pending_approval`) until someone approves or rejects them. Flows with approval mode `auto` skip the queue.

## The queue

`GET /v1/messages` lists the queue (or another status with `?status=`), critical-class flows first (v0.8), then oldest first. Each message carries the flow name and class, the action type, the brain's reasoning, who approved, rejected or edited it, and, when it was edited, the content as drafted (`original`).

## Actions

| Action | Request | From | To |
|---|---|---|---|
| Approve | `POST /v1/messages/:id/approve` (bulk: `/bulk/approve`) | `pending_approval` | `approved` |
| Reject | `POST /v1/messages/:id/reject` (bulk: `/bulk/reject`) | `pending_approval` | `rejected` |
| Edit (v0.8) | `PATCH /v1/messages/:id` `{"subject": "...", "body_markdown": "..."}` | `pending_approval` | unchanged; the drafted version is kept |
| Regenerate (v0.8) | `POST /v1/messages/:id/regenerate` `{"action_type": "..."}` (optional) | `pending_approval` | `pending_generation` |
| Cancel (v0.8) | `POST /v1/messages/:id/cancel` | `approved` | `cancelled` |
| Back to review (v0.8) | `POST /v1/messages/:id/unapprove` | `approved` | `pending_approval` |
| Exclude person (v0.8) | `POST /v1/contacts/:id/exclude` | every unsent message of the person | `cancelled` |
| Retry generation | `POST /v1/messages/:id/retry` | `failed` (generation) | `pending_generation` |

Every transition is a compare-and-swap on the current status: when the message already moved on (another reviewer, the drain), the action answers `409` with the current status and changes nothing. Approving an approved message and cancelling a cancelled one answer `200`.

- **Edit** renders the Markdown body to HTML and text like a drafted body. The first edit keeps the drafted subject and body in `original_subject`, `original_body_html` and `original_body_text`; `edited_by` and `edited_at` record the last edit.
- **Regenerate** sends the message back for a new draft. With `action_type`, the brain drafts that action and skips its decide step (the reviewer took that decision); the value gate still runs.
- **Exclude person** adds a manual suppression of the person's address and cancels every message not handed to the drain yet (`pending_generation`, `generating`, `awaiting_content`, `pending_approval`, `approved`), in one atomic step. A message already `sending` is left to the drain (the suppression check before the send stops it when it has not left yet). Undo with `DELETE /v1/suppressions/:email`; cancelled messages stay cancelled.

The dashboard Approvals screen offers all of these. Keyboard: `j`/`k` move through the queue, `a` approves, `r` rejects, `e` edits. Approved messages that have not been sent yet are listed under **Approved, not sent yet** with **Back to review** and **Cancel send**.

## Reaching reviewers (v0.8)

- An [admin key](API_KEYS.md) with the `messages` scope can list, approve, reject, edit, regenerate and cancel from your own tools.
- The `message.pending_approval` [webhook](WEBHOOKS.md) tells you that messages are waiting. It is batched: at most one per product and endpoint per window (the endpoint's `batch_interval_minutes`, 1 to 1440, default 15), sent at the end of the window, with `pending_count`, the number of messages waiting at delivery time.
- With `settings.approvals.daily_digest: true` ([config](CONFIG.md#settings)), the product's owners get one mail a day, from 08:00 in the product's timezone (`throttle.tenant_timezone`, else UTC), saying how many drafts wait and linking to the Approvals page. It goes through the product's transactional route (no List-Unsubscribe headers) and is skipped on days nothing waits.

## Value gate and LLM budget (v0.8)

- Every AI draft passes the value gate (the assess step) before it reaches the queue. `settings.brain.assess.enabled: false` turns the gate off for the product; `settings.brain.assess.threshold` (1 to 10) asks the gate for a score as well and holds back drafts that score below it (status `value_gated`, the score in the reasoning).
- `settings.llm_daily_token_budget` caps the LLM tokens a product uses per UTC day (every call counts: compile, decide, draft, assess, choose, opening line). Once it is spent, messages that need the LLM wait at `pending_generation` with `status_reason = llm_budget` and are drafted after midnight UTC. The Approvals page shows how many drafts wait for the budget. Fixed-content messages without an AI opening line are not affected.
