# Knowledge base

> Since v0.8: categories, pinned entries, `kb_select` and the import.

The knowledge base holds what the drafting model may say about your product. Entries have a `title`, `content` (markdown, html or text), `tags`, and since v0.8:

| Field | Meaning |
|---|---|
| `category` | Groups entries for [`kb_select`](FLOWS.md#knowledge-base-selection) (`tip_trick`, `feature_edu`, ...) |
| `external_key` | A stable key from your own system (`fundup:kb:12`), unique per product; the import matches on it |
| `data` | The entry's structured source data, kept as a read-only reference |
| `pinned` | Pinned entries always reach the drafting model (oldest first, about 2,000 tokens), for example "Product facts" |
| `imported_at` | When the import last wrote the entry |

`POST /v1/kb` and `PATCH /v1/kb/:id` accept `category`, `external_key`, `data` and `pinned`; `GET /v1/kb` returns them.

In the dashboard (Knowledge Base), an entry shows its category, pinned state and external key, and its source `data` read-only below the content. Editing an entry changes its category and the pinned flag; the external key and data are written by the API and the import only. The list shows each entry's category and a pinned badge.

## Import

```bash
export CLAROS_URL=https://claros.example.com
export CLAROS_ADMIN_KEY=clr_ak_...        # admin key with the "kb" scope
npx @claroshq/claros kb import kb.jsonl --dry-run   # counts only, nothing written
npx @claroshq/claros kb import kb.jsonl
```

The file is JSONL (one entry per line) or a JSON array:

```json
{"external_key": "fundup:kb:12", "title": "Saved searches", "content": "Save a search to ...", "category": "tip_trick", "tags": ["pro", "business"], "data": {"core_insight": "..."}}
{"external_key": "fundup:kb:product_facts", "title": "Product facts", "content": "...", "category": "facts", "pinned": true}
```

Fields: `external_key`, `title`, `content` (up to 8,000 characters) are required; `content_type` (`markdown`), `category`, `tags`, `data`, `pinned` (`false`), `is_active` or `active` (`true`) and `source_url` are optional.

The CLI sends `POST /v1/kb/import` (`?dry_run=1`, `?force=1`; up to 1,000 entries per request, the CLI splits larger files). The API also takes JSONL as `application/x-ndjson`, `application/jsonl`, `application/x-jsonlines` or `text/plain`. Rules:

- Entries are matched by `external_key`. A new key is created (`source = import`).
- An existing entry is overwritten only when nobody changed it in Claros since its last import. An entry edited since then is reported as `skipped_edited` (with its key) unless you pass `--force`. Re-embedding an entry does not count as an edit.
- An entry whose fields already match is `unchanged` and not written; running the same file twice changes nothing.
- The import never deletes: entries missing from the file stay.
- Entries with errors (a missing field, a duplicate key in the file) are listed in `errors` and skipped; the rest are imported.

The response: `{"dry_run": false, "created": 70, "updated": 0, "unchanged": 2, "skipped_edited": 0, "skipped_keys": [], "errors": []}`.

On Postgres with an embedding model configured, new and changed entries are embedded as after a manual edit.
