# API keys

> Since v0.8: admin keys, instance keys and the `clr_` prefixes. Versions up to v0.7 have publishable and secret ingestion keys only.

A product has three kinds of API keys, and the instance has one more (instance keys). Each is shown once when it is created; only a SHA-256 hash is stored. Revoking a key takes effect on the next request.

| Kind | Prefix | Used for | Never used for |
|---|---|---|---|
| Publishable | `clr_pk_` | Writing events from a web page (`/v1/track`, `/v1/identify`, `/v1/batch`) | Anything else |
| Secret | `clr_sk_` | Writing events from your backend | The management API |
| Admin | `clr_ak_` | The management API of one product, limited by its scopes | Writing events, instance routes |
| Instance | `clr_ik_` | Instance automation: products, a product's admin keys and transports, instance reads, erasing a person in every product | Writing events, other product routes |

Keys created before these prefixes existed (`cl_pub_`, `cl_live_`) keep working as publishable and secret keys.

## Admin keys

An admin key lets your backend, CI or a script manage one product without a dashboard session: apply configuration, add and remove suppressions, work the approval queue, read and erase contacts. The same key connects an MCP client such as Claude Code to the product's approval queue (v0.9.0, see [MCP server](MCP.md)).

- Only product owners create, change and revoke admin keys (dashboard: **Integrate**, **Admin key**; API: `POST /v1/ingestion/keys` with `{"kind": "admin", "scopes": [...]}`).
- A request acts on the key's product only. The `X-Claros-Product` header and `?product=` are ignored.
- Ingestion keys never authenticate management routes (401), and admin keys never authenticate ingestion (401).
- Writes to an archived product answer `409`, as for dashboard sessions.

```bash
curl -X POST https://claros.example.com/v1/ingestion/keys \
  -H "Cookie: claros_session=..." -H "Content-Type: application/json" \
  -d '{"kind": "admin", "label": "CI", "scopes": ["config", "suppressions"]}'
# {"key": "clr_ak_...", "kind": "admin", "scopes": ["config", "suppressions"], ...}

curl https://claros.example.com/v1/suppressions?since=2026-11-01T00:00:00Z \
  -H "Authorization: Bearer clr_ak_..."
```

### Scopes

| Scope | Routes |
|---|---|
| `config` | `GET /v1/config`, `PUT /v1/config` ([config as code](CONFIG.md)), `GET /v1/flows`, `POST /v1/flows/:ref/pause`, `POST /v1/flows/:ref/resume`, `POST /v1/flows/:ref/enroll` ([manual enrollment](FLOWS.md)) (`:ref` is the flow id or slug), `GET/POST/DELETE /v1/settings/brand/logo` ([brand logo](INSTALLATION.md#brand-logo), v0.8.5) |
| `suppressions` | `GET/POST /v1/suppressions`, `POST /v1/suppressions/import`, `DELETE /v1/suppressions/:email` |
| `messages` | `GET /v1/messages`, approve, reject, bulk approve and reject, retry, `PATCH /v1/messages/:id`, regenerate, cancel, unapprove, `POST /v1/contacts/:id/exclude` ([approvals](APPROVALS.md)), `POST /v1/import/messages` ([history import](IMPORT.md)) |
| `contacts:read` | `GET /v1/contacts`, `GET /v1/contacts/:id`, `GET /v1/contacts/:id/timeline` |
| `contacts:delete` | `DELETE /v1/contacts/:external_id` |
| `kb` | `GET/POST /v1/kb`, `GET/PATCH/DELETE /v1/kb/:id`, `POST /v1/kb/import` ([knowledge base import](KB.md#import)), `POST /v1/kb/re-embed` |
| `events` | `POST /v1/import/events`, `POST /v1/import/lifecycle` ([history import](IMPORT.md), v0.8.11) |
| `broadcasts` | Reserved for broadcasts (not released yet) |

The [MCP endpoint](MCP.md) `POST /v1/mcp` takes admin keys only and offers the tools of the key's scopes: `messages` (the approval queue), `contacts:read` (contact lookups) and `config` (list, pause and resume flows).

A route the key's scopes do not cover answers `403`. Routes without a scope (other flow routes, settings, team, keys) accept dashboard sessions only.

Pausing an active flow and resuming a paused one follow the flow status rules: a draft cannot be paused (`422`), resuming needs a compiled plan (`422`), and a flow already in the target status answers `200` unchanged.

```bash
curl -X POST https://claros.example.com/v1/flows/subscribe_nudge/pause -H "Authorization: Bearer clr_ak_..."
```

Approvals and edits made with an admin key are recorded as `api_key:<key id>` in `approved_by`, `rejected_by` and `edited_by`; dashboard users as `user:<user id>`.

## Instance keys

An instance key automates the whole install from a script or CI: create products, give each an admin key, set up its transports, read instance health, and erase a person everywhere. It is not bound to a product.

- Only instance admins create, list and revoke instance keys, in the dashboard (**Settings**, **Products**, **Instance keys**) or with `GET/POST /v1/instance/keys` and `POST /v1/instance/keys/:id/revoke` (session only; an instance key cannot manage instance keys).
- Routes that belong to one product take the product from the `X-Claros-Product: <slug>` header or `?product=<slug>`: `400` when neither is given, `404` for an unknown slug. Writes to an archived product answer `409`.
- Instance keys never authenticate ingestion or any product route their scopes do not list (`401`), and product admin keys never authenticate instance routes (`401`).
- Actions are recorded as `api_key:<key id>`, as for admin keys.

| Scope | Routes |
|---|---|
| `products:write` | `GET/POST /v1/products`, `PATCH /v1/products/:slug`, `POST /v1/products/:slug/archive` and `/unarchive`. A product created with an instance key has no owner yet; instance admins act on it as owners. |
| `keys:write` | A product's keys: `GET /v1/ingestion/keys`, and for admin keys only `POST /v1/ingestion/keys`, `PATCH /v1/ingestion/keys/:id`, `POST /v1/ingestion/keys/:id/revoke` |
| `transports:write` | A product's transports: `GET/POST /v1/settings/transports`, `PATCH/DELETE /v1/settings/transports/:id`, `POST /v1/settings/transports/:id/test`, `PUT /v1/settings/transport-routing` |
| `instance:read` | `GET /v1/instance`, `GET /v1/instance/health`, `GET /v1/products`, `GET /v1/capabilities` |
| `people:erase` | `DELETE /v1/instance/people/:email` |

```bash
# Create a product and give it an admin key for its config
curl -X POST https://claros.example.com/v1/products \
  -H "Authorization: Bearer clr_ik_..." -H "Content-Type: application/json" \
  -d '{"name": "Acme", "slug": "acme"}'
curl -X POST https://claros.example.com/v1/ingestion/keys \
  -H "Authorization: Bearer clr_ik_..." -H "X-Claros-Product: acme" -H "Content-Type: application/json" \
  -d '{"kind": "admin", "label": "CI", "scopes": ["config"]}'
```

### Erasing a person in every product

`DELETE /v1/instance/people/:email` erases every contact with this email (ignoring case) in every product, as `DELETE /v1/contacts/:external_id` does in one product: events, flow memberships, messages, topic statuses and notes go, suppressions stay. Instance admin session or an instance key with `people:erase`.

```json
{ "erased": [{ "product": "acme", "contact_id": "...", "external_id": "u_42" }], "count": 1 }
```

## Capabilities

`GET /v1/capabilities` says what the instance supports, so a script can check before relying on a feature. Any dashboard session, any product admin key, or an instance key with `instance:read`.

```json
{ "backend": "postgres", "runtime": "node",
  "kb": { "semantic": true }, "events": { "partitioned": true },
  "transports": ["resend", "smtp", "cloudflare"],
  "features": ["multi_product", "topics", "date_triggers", "choose_step", "instance_keys", "..."] }
```

- `backend`: `postgres` or `d1`; `runtime`: `node` or `workers`.
- `kb.semantic`: similarity search over embeddings is supported (Postgres with pgvector, D1 without a vector index). It runs once the product has an [embedding provider](KB.md#search-and-embeddings); without one, entries are found by word matching.
- `events.partitioned`: monthly partitions of the events table (Postgres); D1 keeps a plain table.
- `features`: stable ids, added as features ship and never renamed.

## Suppression API

| Request | Effect |
|---|---|
| `POST /v1/suppressions` `{"emails": [...], "reason": "manual"}` | Suppress up to 1000 addresses. `reason`: `manual` (default), `unsubscribe`, `hard_bounce`, `complaint`, `imported`. Answers `{added, skipped, invalid}`. The single-address form `{"email": "..."}` is unchanged. |
| `DELETE /v1/suppressions/:email` | Remove one suppression. `complaint` and `hard_bounce` suppressions are removed only with `?force=1` (otherwise `409` with the reason). |
| `GET /v1/suppressions?since=<ISO-8601>` | Suppressions created at or after `since`, paginated as before (`limit`, `after`). |
| `DELETE /v1/contacts/:external_id` | Erase a contact of the product: its events, flow memberships, messages, topic statuses and notes. Suppressions stay, so the address is not mailed again. Owner session or `contacts:delete`. Owners can also do this from the person's page (**Delete person**). |

Notes on a person (`GET` and `POST /v1/contacts/:id/notes` `{"body": "..."}`, `DELETE /v1/contacts/:id/notes/:noteId`) take a member session only; no admin key scope reaches them. Notes are for the team: the engine does not read them and they are never sent to the LLM.

Adding and removing suppressions sends the `contact.suppressed` and `contact.resubscribed` [webhooks](WEBHOOKS.md).
