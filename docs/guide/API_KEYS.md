# API keys

> Status: unreleased (planned for v0.8). Admin keys and the `clr_` prefixes are not in released versions up to v0.7.

A product has three kinds of API keys. Each is shown once when it is created; only a SHA-256 hash is stored. Revoking a key takes effect on the next request.

| Kind | Prefix | Used for | Never used for |
|---|---|---|---|
| Publishable | `clr_pk_` | Writing events from a web page (`/v1/track`, `/v1/identify`, `/v1/batch`) | Anything else |
| Secret | `clr_sk_` | Writing events from your backend | The management API |
| Admin | `clr_ak_` | The management API of one product, limited by its scopes | Writing events |

Keys created before these prefixes existed (`cl_pub_`, `cl_live_`) keep working as publishable and secret keys.

## Admin keys

An admin key lets your backend, CI or a script manage one product without a dashboard session: apply configuration, add and remove suppressions, work the approval queue, read and erase contacts.

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
| `config` | `GET /v1/config`, `PUT /v1/config` ([config as code](CONFIG.md)) |
| `suppressions` | `GET/POST /v1/suppressions`, `POST /v1/suppressions/import`, `DELETE /v1/suppressions/:email` |
| `messages` | `GET /v1/messages`, approve, reject, bulk approve and reject, retry, `PATCH /v1/messages/:id`, regenerate, cancel, unapprove, `POST /v1/contacts/:id/exclude` ([approvals](APPROVALS.md)) |
| `contacts:read` | `GET /v1/contacts`, `GET /v1/contacts/:id`, `GET /v1/contacts/:id/timeline` |
| `contacts:delete` | `DELETE /v1/contacts/:external_id` |
| `kb` | `GET/POST /v1/kb`, `GET/PATCH/DELETE /v1/kb/:id`, `POST /v1/kb/re-embed` |
| `broadcasts` | Reserved for broadcasts (not released yet) |

A route the key's scopes do not cover answers `403`. Routes without a scope (flows, settings, team, keys) accept dashboard sessions only.

Approvals and edits made with an admin key are recorded as `api_key:<key id>` in `approved_by`, `rejected_by` and `edited_by`; dashboard users as `user:<user id>`.

## Suppression API

| Request | Effect |
|---|---|
| `POST /v1/suppressions` `{"emails": [...], "reason": "manual"}` | Suppress up to 1000 addresses. `reason`: `manual` (default), `unsubscribe`, `hard_bounce`, `complaint`, `imported`. Answers `{added, skipped, invalid}`. The single-address form `{"email": "..."}` is unchanged. |
| `DELETE /v1/suppressions/:email` | Remove one suppression. `complaint` and `hard_bounce` suppressions are removed only with `?force=1` (otherwise `409` with the reason). |
| `GET /v1/suppressions?since=<ISO-8601>` | Suppressions created at or after `since`, paginated as before (`limit`, `after`). |
| `DELETE /v1/contacts/:external_id` | Erase a contact of the product: its events, flow memberships, messages and topic statuses. Suppressions stay, so the address is not mailed again. Owner session or `contacts:delete`. |

Adding and removing suppressions sends the `contact.suppressed` and `contact.resubscribed` [webhooks](WEBHOOKS.md).
