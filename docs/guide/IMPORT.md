# Importing history

When a product moves to Claros from another system, its history matters. Users who signed up a year ago are not new, users who stopped using the product months ago are not active, and the mail the old system sent counts toward frequency caps and "already sent" checks. Three imports bring that history in:

1. [Events](#events) (since v0.8.11): what each user did, with the original timestamps.
2. [Lifecycle recompute](#lifecycle-recompute) (since v0.8.11): each contact's lifecycle state, first and last seen, activation time and engagement counters, replayed from its events.
3. [Sent messages](#sent-messages) (since v0.8): the mail the old system sent.

None of them sends mail, enrolls a contact in a flow, queues a job or fires a webhook. Run them in this order: identify your users first (so contacts have their email and traits), then events, then the lifecycle recompute, then sent messages.

## Before you import

Importing never triggers anything by itself, but what you import changes what the scan sees afterwards:

- **Segment-triggered flows** enroll every contact that is in their cell or lifecycle state at the next scan, however it got there. After the recompute, contacts who stopped using the product long ago are `dormant` or `churned`, so a segment flow on those states enrolls them. Pause segment flows before the recompute and resume them on purpose; the dry run lists how many contacts each one would match.
- **Lifecycle-transition flows** (for example a win back on `-> churned`) react only to transitions the scan makes. The recompute leaves every contact in the state its history leads to at that moment, so the next scan makes no transition. Contacts who are close to a threshold do cross it in the following days, as they would have without the import; the dry run shows how many (`upcoming`).
- **Event-triggered flows** never see imported events.
- Set `settings.lifecycle` (`activation_events`, `engagement_events`, the day thresholds) before the recompute: it applies the current settings to the whole history.

## Events

> Since v0.8.11.

```bash
export CLAROS_URL=https://claros.example.com
export CLAROS_ADMIN_KEY=clr_ak_...                 # admin key with the "events" scope
npx @claroshq/claros import events events.jsonl --dry-run   # resolves and counts, writes nothing
npx @claroshq/claros import events events.jsonl
```

One event per line:

```json
{"external_id": "u_42", "event": "signed_up", "timestamp": "2025-03-02T10:15:00Z", "id": "signed_up:u_42"}
{"external_id": "u_42", "event": "active_day", "properties": {"channel": "web"}, "timestamp": "2026-06-14T08:02:11Z", "id": "active_day:u_42:2026-06-14"}
{"email": "ada@example.com", "event": "payment_failed", "timestamp": "2026-09-01T03:00:00Z"}
```

| Field | Meaning |
|---|---|
| `external_id` or `email` | The contact: by external id, else by email (case-insensitive). A contact that does not exist is created when `external_id` is given (in `signed_up`, without email or traits; identify it to add them). An unknown email alone is an error |
| `event` | The track event name |
| `timestamp` | Required; ISO-8601 with a timezone. Not in the future |
| `properties` | Optional object, stored with the event |
| `type` | Optional, only `"track"` |
| `id` | Optional; stored as the event's `messageId`. Use the `messageId` your product sends live for the same event (for example `active_day:<user>:<day>`), so an event that reaches Claros both live and from the import is stored once. Without it an event is identified by contact, name and timestamp |

`POST /v1/import/events` takes the same items (a JSON array, `{"events": [...]}`, or JSONL; up to 2,000 per request, the CLI splits larger files). Response: `{"dry_run": false, "imported": 1998, "duplicates": 2, "contacts_created": 0, "errors": [{"index": 17, "error": "timestamp: in the future"}]}`.

What an imported event is:

- an event with its own `timestamp` and `received_at` at the import, `context` `{"source": "import"}`;
- part of the contact's history: the contact timeline, the event summaries in draft context (which look at recent weeks by event time) and the lifecycle recompute see it;
- nothing else: it does not move the contact's lifecycle state, `last_seen_at` or counters (the recompute does that, from all events at once), and it triggers no flow.

## Lifecycle recompute

> Since v0.8.11.

```bash
npx @claroshq/claros import lifecycle --dry-run   # counts only
npx @claroshq/claros import lifecycle
```

```text
Dry run: contacts 500, to change 480, applied 0, skipped 0, transitions 3200
States before: signed_up 500
States after:  churned 260, signed_up 110, engaged 70, dormant 35, at_risk 25
Next 14 days without new activity: churned 9, dormant 6, at_risk 4
Retention grid (tenure/recency): loyal/dormant 240, ...
Segment flow nurture (paused): 60 contacts match (before its where)
```

(Example output; your numbers come from your history.)

For every contact the recompute replays its events in time order through the same rules as live ingest and the scan:

- the first event sets `first_seen_at`; events in `engagement_events` (every event when the list is empty) move `last_seen_at` and count toward the engagement counters;
- `signed_up -> activated` when all `activation_events` have occurred, `activated_at` at that moment; activity after activation, at risk or dormant leads to `engaged`, activity after churn to `resurrected` and then `engaged`;
- `engaged -> at_risk -> dormant -> churned` at the moment each inactivity threshold of `settings.lifecycle` is crossed.

The result replaces the contact's `lifecycle_state`, `first_seen_at`, `last_seen_at`, `activated_at` and engagement counters. The transitions of the replay are stored with their original times and `metadata` `{"source": "import"}`, so the contact timeline and lifecycle analytics show them; they enroll no one. Running the recompute again replaces those import transitions and changes nothing when the history is the same.

`POST /v1/import/lifecycle` (no body; admin key with the `events` scope or an owner session) works on up to `limit` contacts (default 200, at most 500) after `cursor` and answers `next_cursor` until the last page; the CLI pages for you. `?dry_run=1` writes nothing. `?forecast_days=` (default 14, at most 90) sets the `upcoming` window. Response:

```json
{
  "dry_run": true, "contacts": 200, "changed": 196, "applied": 0, "skipped": 0, "transitions": 1402,
  "states_before": {"signed_up": 200}, "states": {"churned": 120, "engaged": 31, "signed_up": 49},
  "upcoming": {"days": 14, "to": {"churned": 4}},
  "grid": {"loyal/dormant": 118, "established/active": 22},
  "segment_flows": [{"slug": "nurture", "name": "Nurture", "status": "paused", "matching": 120}],
  "next_cursor": "0f9c..."
}
```

A contact that receives a live event while the recompute runs is skipped (`skipped`) rather than overwritten; run the recompute again. Contacts without events keep their fields.

## Sent messages

> Since v0.8.

```bash
export CLAROS_URL=https://claros.example.com
export CLAROS_ADMIN_KEY=clr_ak_...                 # admin key with the "messages" scope
npx @claroshq/claros import messages history.jsonl --dry-run # resolves and counts, writes nothing
npx @claroshq/claros import messages history.jsonl
```

One message per line:

```json
{"external_id": "u_42", "flow_slug": "nurture", "step_order": 1, "action_type": "tip_trick", "subject": "A faster way to find leads", "sent_at": "2026-09-14T09:12:00Z", "kb_external_key": "fundup:kb:12"}
{"email": "ada@example.com", "flow_slug": "winback", "action_type": "winback", "sent_at": "2026-10-01T10:00:00Z", "id": "legacy-msg-9912"}
```

| Field | Meaning |
|---|---|
| `external_id` or `email` | The contact: by external id, else by email (case-insensitive). The contact must exist (identify it first) |
| `flow_slug` | An existing flow of the product |
| `step_order` | Default 1 |
| `action_type`, `sent_at` | Required; `sent_at` is ISO-8601 with a timezone |
| `subject` | Optional |
| `kb_external_key` | The [knowledge base](KB.md) entry the message was about; `kb_select` never sends it to this contact again |
| `id` | Optional idempotency key; without it a message is identified by contact, flow, step, action and `sent_at` |

`POST /v1/import/messages` takes the same items (a JSON array, `{"messages": [...]}`, or JSONL as `application/x-ndjson`, `application/jsonl`, `application/x-jsonlines` or `text/plain`; up to 2,000 per request, the CLI splits larger files). Response: `{"dry_run": false, "imported": 2239, "duplicates": 2, "errors": [{"index": 17, "error": "contact not found (by external_id or email)"}]}`.

What an imported message is:

- a `sent` message with `imported = true` and `status_reason = imported`, with a completed enrollment of the flow (exit reason `imported`) at `sent_at`;
- counted by the frequency caps (by `sent_at`), the re-entry policy of its flow, `history` and `first_contact` conditions, choose-step cooldowns and `kb_select` deduplication;
- never sent again; it appears in sent counts and the Sent log at its `sent_at`, without opens or clicks (it has no provider message id).

Running the same file again imports nothing new (duplicates are counted). Items with errors are listed and skipped; the rest are imported.
