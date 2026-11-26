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

## Search and embeddings

An entry reaches the drafting model in one of four ways:

| Way | Needs embeddings |
|---|---|
| `pinned` entries, always | No |
| [`kb_select`](FLOWS.md#knowledge-base-selection) on a step | No (`best_match` is word overlap) |
| `kb_ref` on a compiled step: the entry with that exact title | No |
| Search: up to 3 entries related to the step's instruction | Optional |

Search is semantic when the product has an embedding provider: the entry and the query are turned into vectors and compared by cosine similarity (pgvector on Postgres; on D1 over the stored vectors, without an index). Without a provider, search matches words: entries that share at least two words with the step's instruction (common words such as "the" or "about" do not count), most shared first.

### Embedding provider

Embeddings have their own provider, separate from the LLM provider, because Anthropic has no embeddings API. Set it in the dashboard (**Settings**, **AI providers**, **Embeddings**) or with the API (owner session):

```bash
curl -X PUT https://claros.example.com/v1/settings/embeddings \
  -H "Cookie: claros_session=..." -H "Content-Type: application/json" \
  -d '{"provider": "openai", "api_key": "sk-..."}'
```

| Provider | Base URL | Model |
|---|---|---|
| `openai` | `https://api.openai.com/v1` (default) | `text-embedding-3-small` (default) |
| `custom` | required: any OpenAI-compatible `/embeddings` endpoint | required |

- The model must return 1536-dimension vectors. Saving makes one embedding call and refuses (`422`, nothing stored) a model that answers another size, a rejected key or an unreachable endpoint. `dimensions: 1536` is sent when the endpoint accepts it, so models that can shorten their vectors (such as `text-embedding-3-large`) work.
- `GET /v1/settings/embeddings` returns the provider in use, never the key: `source` is `embedding_config` (saved here) or `llm_config` (the LLM provider also embeds: OpenAI, a custom endpoint, or an explicit `embedding_model` on the LLM config, as in earlier versions). `null` means none: an Anthropic or Ollama LLM provider does not embed.
- Saving or removing (`DELETE /v1/settings/embeddings`) a provider with another endpoint, model or dimensions drops the stored vectors, because vectors from different models cannot be compared, and starts re-embedding (100 entries per call; **Retry failed embeddings** or `POST /v1/kb/re-embed` takes the rest).

### Embedding states

| `embedding_status` | Badge | Meaning |
|---|---|---|
| `null` | embedded | The entry has a vector |
| `pending` | embedding | A job is queued |
| `failed` | embed failed | The provider refused; `embedding_error` has its answer. Fix the provider, then retry |
| `skipped` | not embedded | No vector and no job: there was no embedding provider, or the vectors were dropped after a model change |

`POST /v1/kb/re-embed` (or **Retry failed embeddings**) queues entries that are `failed`, `skipped`, never queued, or `pending` for more than 15 minutes. An entry without a vector is still used by pinning, `kb_select` and `kb_ref`, and by word matching when the product has no embedding provider; with a provider, search only finds embedded entries.

## Adding entries

Four ways, all writing the same entries:

| Way | For |
|---|---|
| Dashboard, **Knowledge Base**, **New entry** | Writing one entry by hand |
| Dashboard, **Knowledge Base**, **Import** | Files you already have: Markdown, text, CSV, JSONL or JSON |
| `POST /v1/kb/import` or `npx @claroshq/claros kb import` | Keeping the knowledge base in sync from your own system |
| `POST /v1/kb` | One entry from a script |

The API routes take a dashboard session or an [admin key](API_KEYS.md#admin-keys) with the `kb` scope (a product owner creates one on **Integrate**, **Admin key**).

## Import

> The API and CLI import since v0.8. The dashboard import page ships in the next release (CHANGELOG, Unreleased).

### In the dashboard

**Knowledge Base**, **Import** walks through three steps:

1. **Choose files**: drop or pick files (several at once), or paste text. The page explains each format and offers an example file for each.
2. **Check**: the files are read in the browser. Rows with a problem (a missing title, content over 8,000 characters, an invalid `pinned` value, two rows with the same key) are listed with their file and row and skipped. The rest are sent as a dry run, and the page shows how many entries would be **new**, **updated**, **unchanged** and **edited in Claros** (kept as edited unless you tick **Overwrite entries edited in Claros**). Nothing is written in this step.
3. **Import**: the entries are written (in batches of up to 500), and the page reports the counts and what happens next: new and changed entries are embedded when the product has an embedding provider.

How each format becomes entries:

| Format | Entries | Title | `external_key` |
|---|---|---|---|
| Markdown (`.md`, `.markdown`, `.mdx`) | One per file | Front matter `title`, else the first `# ` heading, else the file name | Front matter `external_key`, else `md:<file name>` |
| Markdown longer than 8,000 characters | One per `## ` section (the text before the first `## ` is one more) | `<document title>: <section heading>` | `md:<file name>#<section slug>` |
| Text (`.txt`) | One per file, `content_type` `text` | The file name | `txt:<file name>` |
| CSV (`.csv`, `.tsv`; comma, semicolon or tab) | One per row below the header | The `title` column | The `external_key` column (or `key`, `id`), else `csv:<title slug>` |
| JSONL (`.jsonl`, `.ndjson`) or JSON (`.json`) | One per line or array item | `title` | `external_key` (required) |
| Pasted text | Markdown: one entry (or one per section), keyed `paste:<title slug>`; CSV, JSONL and JSON as files | | |

- Markdown front matter may set `title`, `external_key`, `category`, `tags` (`[a, b]` or a list), `pinned` and `active`.
- CSV needs a header row naming `title` and `content` (`body` and `text` are read as `content`). Optional columns: `external_key`, `category`, `tags` (separated by commas, semicolons or `|`), `pinned`, `active` (`true`/`false`, `yes`/`no`, `1`/`0`), `content_type`, `source_url`. Other columns are kept in the entry's `data`.
- A key built from a file name or a title changes when the file or title is renamed, and the import then creates a new entry and keeps the old one. Give entries an `external_key` (a CSV column, front matter, or JSONL) when you will import again.

### From your own system: API and CLI

```bash
export CLAROS_URL=https://claros.example.com
export CLAROS_ADMIN_KEY=clr_ak_...        # admin key with the "kb" scope
npx @claroshq/claros kb import kb.jsonl --dry-run   # counts only, nothing written
npx @claroshq/claros kb import kb.jsonl
```

```bash
curl -X POST "https://claros.example.com/v1/kb/import?dry_run=1" \
  -H "Authorization: Bearer clr_ak_..." \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @kb.jsonl
```

The CLI and the API take JSONL (one entry per line) or a JSON array; convert Markdown or CSV with the dashboard, or write JSONL from your own system:

```json
{"external_key": "fundup:kb:12", "title": "Saved searches", "content": "Save a search to ...", "category": "tip_trick", "tags": ["pro", "business"], "data": {"core_insight": "..."}}
{"external_key": "fundup:kb:product_facts", "title": "Product facts", "content": "...", "category": "facts", "pinned": true}
```

Fields: `external_key`, `title`, `content` (up to 8,000 characters) are required; `content_type` (`markdown`), `category`, `tags`, `data`, `pinned` (`false`), `is_active` or `active` (`true`) and `source_url` are optional.

The CLI sends `POST /v1/kb/import` (`?dry_run=1`, `?force=1`; up to 1,000 entries and 4 MB per request, the CLI splits larger files). The API takes a JSON array, `{"entries": [...]}`, or JSONL as `application/x-ndjson`, `application/jsonl`, `application/x-jsonlines` or `text/plain`.

To add a single entry from a script, `POST /v1/kb` with `title`, `content` and the optional fields above (an `external_key` lets a later import update it):

```bash
curl -X POST https://claros.example.com/v1/kb \
  -H "Authorization: Bearer clr_ak_..." -H "Content-Type: application/json" \
  -d '{"title": "Refund policy", "content": "Refunds within 30 days of payment.", "category": "facts"}'
```

### Rules

The dashboard, the CLI and the API follow the same rules:

- Entries are matched by `external_key`. A new key is created (`source = import`).
- An existing entry is overwritten only when nobody changed it in Claros since its last import. An entry edited since then is reported as `skipped_edited` (with its key) unless you pass `--force` (`?force=1`, or **Overwrite entries edited in Claros** in the dashboard). Re-embedding an entry does not count as an edit.
- An entry whose fields already match is `unchanged` and not written; running the same file twice changes nothing, so a failed import can be run again.
- The import never deletes: entries missing from the file stay.
- Entries with errors (a missing field, a duplicate key in the file) are listed in `errors` and skipped; the rest are imported.

The response: `{"dry_run": false, "created": 70, "updated": 0, "unchanged": 2, "skipped_edited": 0, "skipped_keys": [], "errors": []}`.

New and changed entries are embedded as after a manual edit when the product has an [embedding provider](#search-and-embeddings).
