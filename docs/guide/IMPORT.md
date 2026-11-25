# Importing send history

> Status: unreleased (planned for v0.8).

When a product moves to Claros from another system, the mail that system already sent matters: frequency caps, re-entry, "already sent" and history conditions, and knowledge base deduplication should treat it like mail Claros sent. The history import brings those messages in.

```bash
export CLAROS_URL=https://claros.example.com
export CLAROS_ADMIN_KEY=clr_ak_...                 # admin key with the "messages" scope
npx claros import messages history.jsonl --dry-run # resolves and counts, writes nothing
npx claros import messages history.jsonl
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

`POST /v1/import/messages` takes the same items (a JSON array, `{"messages": [...]}`, or JSONL as `text/plain`; up to 2,000 per request, the CLI splits larger files). Response: `{"dry_run": false, "imported": 2239, "duplicates": 2, "errors": [{"index": 17, "error": "contact not found (by external_id or email)"}]}`.

What an imported message is:

- a `sent` message with `imported = true` and `status_reason = imported`, with a completed enrollment of the flow (exit reason `imported`) at `sent_at`;
- counted by the frequency caps (by `sent_at`), the re-entry policy of its flow, `history` and `first_contact` conditions, choose-step cooldowns and `kb_select` deduplication;
- never sent again; it appears in sent counts and the Sent log at its `sent_at`, without opens or clicks (it has no provider message id).

Running the same file again imports nothing new (duplicates are counted). Items with errors are listed and skipped; the rest are imported.
