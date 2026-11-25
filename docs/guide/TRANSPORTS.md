# Transports

> Since v0.8: several transports per product, routing and Cloudflare Email Service. Versions up to v0.7 have one transport per product, Resend or SMTP.

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

Use Cloudflare Email Service for the transactional route and another transport (Resend or SMTP) as the default. On Postgres + Node, Claros calls the REST API (`POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`) with an API token.

### Cloudflare Email Service on a Workers install

On Cloudflare Workers, Claros can send through the Worker's `send_email` binding `EMAIL` instead of the REST API. `claros deploy` and `claros upgrade` (from v0.8.2) add the binding to every instance:

```jsonc
"send_email": [{ "name": "EMAIL" }]
```

The binding has no sender or recipient restriction ([send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/)); Cloudflare accepts a sender only on a domain onboarded to Email Service, in the same account as the Worker. To use it:

1. Onboard the sender domain to Email Service in the account the Worker runs in (Cloudflare dashboard, Compute, Email Service, Email Sending, Onboard Domain; see [domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/)).
2. Add a `cloudflare` transport with a `from_email` on that domain and without `account_id` and `api_token` (`POST /v1/settings/transports` with `kind: "cloudflare"`, or Settings, Transports).
3. Route transactional mail to it (`PUT /v1/settings/transport-routing`, transactional route) and keep another transport as the default. Only topics of kind `transactional` are sent through it.

A `cloudflare` transport stored with an `account_id` and `api_token` keeps using the REST API with those credentials, also when the Worker has the binding. Instances deployed before v0.8.2 get the binding with `npx claros upgrade`.

A sender domain that is not onboarded fails with `E_SENDER_DOMAIN_NOT_AVAILABLE` (permanent); one still being set up fails with `E_EMAIL_SENDING_NOT_READY` and is retried.
