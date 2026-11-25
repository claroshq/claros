# Transports

> Status: several transports per product, routing and Cloudflare Email Service are unreleased (planned for v0.8). Released versions up to v0.7 have one transport per product, Resend or SMTP.

A transport is how a product's mail leaves Claros. Each product brings its own credentials; they are stored encrypted with `ENCRYPTION_KEY` and never shown again.

| Kind | Credentials | Notes |
|---|---|---|
| `resend` | API key, optional webhook secret | Delivery feedback (bounces, complaints, opens, clicks) through the Resend webhook. Messages carry Resend tags `claros_tenant`, `claros_message_id`, `claros_flow`. |
| `smtp` | host, port, TLS mode, optional username and password | Any SMTP server. No delivery feedback. On Workers it uses `worker-mailer` over TCP sockets. |
| `cloudflare` | account id and API token (REST API), or the Workers `send_email` binding | Cloudflare Email Service, **for transactional mail only**. |

Every transport has a from address and name, an optional Reply-To (when unset, the product's branding Reply-To is used, if any) and an optional daily limit. The daily limit applies per transport: when a transport reaches it, its messages wait until the next day while other transports keep sending. Claros does not know your provider plan; it only enforces the limit you set.

## Managing transports

In the dashboard: Settings, Transports (add, send a test email, remove, routing). Over the API (owner role for writes):

- `GET /v1/settings/transports`: active transports, the saved routing and the transport each route resolves to (`effective`).
- `POST /v1/settings/transports`: `kind`, `from_email`, optional `name`, `from_name`, `reply_to`, `daily_limit`, plus the credentials of the kind (`api_key`, `webhook_secret`; `host`, `port`, `secure`, `username`, `password`, `reject_unauthorized`; `account_id`, `api_token`). SMTP credentials are verified before anything is stored.
- `PATCH /v1/settings/transports/:id`: change any of those fields; credentials are replaced only when sent.
- `DELETE /v1/settings/transports/:id`: deactivates the transport (kept for history) and removes it from routing.
- `POST /v1/settings/transports/:id/test`: `{ "to": "you@example.com" }` sends a branded test email through that transport.

The v0.6 endpoints keep working: `GET /v1/settings/transport` returns the default transport and `PUT /v1/settings/transport` replaces it, leaving other transports active.

## Routing

Each message takes one of two routes:

- **transactional**: messages whose topic kind is `transactional` (see [Topics and consent](TOPICS.md));
- **default**: everything else, including messages without a topic.

Set the routes with `PUT /v1/settings/transport-routing`:

```json
{ "default": "<transport id>", "transactional": "<transport id>" }
```

`null` clears a route. Without a transactional route, transactional mail uses the default route. Without a default route, the oldest active transport is the default, so a product with one transport needs no routing at all.

## Cloudflare Email Service is for transactional mail only

Cloudflare's terms do not allow marketing mail through Cloudflare Email Service, so Claros enforces a hard guard:

- the default route cannot be a `cloudflare` transport (`PUT /v1/settings/transport-routing` answers 400);
- right before sending, a message whose topic kind is not `transactional` and that would go through a `cloudflare` transport is marked `failed` with `status_reason = transport_policy` and is not retried.

Use Cloudflare Email Service for the transactional route and another transport (Resend or SMTP) as the default. On Postgres + Node, Claros calls the REST API (`POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`) with an API token. On Cloudflare Workers, add the binding to `wrangler.jsonc` and the account id and token can stay empty:

```jsonc
"send_email": [{ "name": "EMAIL" }]
```
