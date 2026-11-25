# Webhooks and the analytics sink

> Since v0.8.

Claros tells your product what happened to its contacts and messages with signed HTTP webhooks, and can send lifecycle events to an analytics tool. Both are configured per product with [config as code](CONFIG.md) (`webhooks` and `settings.analytics`); webhooks can also be managed one by one in the dashboard (Settings, Webhooks) or with the [webhooks API](#managing-webhooks).

## How delivery works

Each event is written to an outbox in the same database transaction as the change it reports (a message marked sent, a suppression added), one row per subscribed endpoint. A delivery job sends due rows every minute on Postgres + Node and every 5 minutes on Workers + D1.

- A `2xx` answer is a delivery. Anything else, a timeout (10 seconds) or a network error is retried after 1 minute, then 2, 4, 8 ... minutes, at most 12 hours apart, 12 attempts in all; after that the row is marked dead.
- Delivery is at least once. Use `webhook-id` to drop duplicates.
- Delivery never blocks sending: a slow or failing receiver only delays its own events.
- Removing an endpoint drops its undelivered events. Erasing a contact drops the undelivered events about it.

## Events

| Event | When |
|---|---|
| `message.sent` | The transport accepted the message |
| `message.delivered` | The provider reported delivery (Resend) |
| `message.opened` | First open reported by the provider |
| `message.clicked` | First click reported by the provider |
| `message.bounced` | Hard bounce reported by the provider |
| `message.complained` | Spam complaint reported by the provider |
| `message.failed` | The send failed permanently, the transport policy refused it, the recovery job gave up on a stuck message (`reason: "reap_sending"`, `"reap_generating"`, `"reap_awaiting_content"`), or content generation failed permanently (`reason: "generation_failed"`) |
| `message.pending_approval` | Messages entered the approval queue. Batched: at most one per product and endpoint per window (the endpoint's `batch_interval_minutes`, default 15), delivered at the end of the window with `pending_count` |
| `contact.subscribed` | An identify call's `topics` subscribed the contact to a topic they were not subscribed to (`scope: "topic"`, `topic`, `source: "identify"`) |
| `contact.unsubscribed` | Unsubscribe from the product (`scope: "product"`) or from a topic (`scope: "topic"`, `topic`), including through an identify call's `topics` (`source: "identify"`) |
| `contact.resubscribed` | A suppression was removed, or the contact subscribed to a topic again on the unsubscribe page |
| `contact.suppressed` | An address was suppressed (bounce, complaint, API, dashboard, exclusion, CSV import with `source: "csv_import"`) |
| `flow.enrolled` | A contact entered a flow |
| `flow.exited` | A contact left a flow early (`reason`: `condition_met`, `flow_archived`, `priority_override`) |

## Request

```http
POST /your/webhook HTTP/1.1
Content-Type: application/json
webhook-id: 7f0c2f0e-...            (the outbox row id: the same on every retry)
webhook-timestamp: 1795253400       (unix seconds)
webhook-signature: v1,K5o...=

{
  "type": "message.sent",
  "timestamp": "2026-11-20T10:00:00.000Z",
  "data": {
    "product": "acme",
    "contact": { "external_id": "user_123", "email": "ada@example.com" },
    "message": { "id": "...", "subject": "Welcome", "action_type": "welcome", "step": 1, "topic": "lifecycle" },
    "flow": { "id": "...", "slug": "welcome", "name": "Welcome" }
  }
}
```

`data` carries what applies to the event: `contact` (with your `external_id`), `message`, `flow`, and `reason`, `scope`, `topic`, `source`, `decision`, `membership_id` or `pending_count`.

## Verifying signatures

Signatures follow [Standard Webhooks](https://www.standardwebhooks.com): HMAC-SHA256 over `"{webhook-id}.{webhook-timestamp}.{body}"`, keyed with the base64 part of the `whsec_` secret, base64 encoded, prefixed `v1,`.

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret: string, headers: Record<string, string>, body: string): boolean {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sig = headers["webhook-signature"];
  if (!id || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // reject old or future timestamps
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return sig.split(" ").some((part) => {
    const got = Buffer.from(part.replace(/^v1,/, ""));
    const want = Buffer.from(expected);
    return got.length === want.length && timingSafeEqual(got, want);
  });
}
```

Verify against the raw body, before parsing it. Fail closed: answer `401` and do nothing when the signature does not match.

A webhook in the config without `secret` gets a generated one, returned once by the apply (`webhook_secrets`). With `secret`, that value is used; applying a new value rotates it.

## Managing webhooks

Settings, Webhooks in the dashboard lists the product's endpoints and their latest deliveries, and creates, edits, enables, disables and deletes them. The same operations are an API for owners and for admin keys with the `config` scope:

| Request | Does |
|---|---|
| `GET /v1/webhooks` | The endpoints (`slug`, `url`, `events`, `enabled`, `batch_interval_minutes`, `has_secret`, `read_only`) and the list of subscribable `events` |
| `POST /v1/webhooks` | Create: `{"slug": "app", "url": "https://...", "events": [...], "enabled"?: true, "batch_interval_minutes"?: 15}`. The answer carries the signing `secret`, shown this once |
| `PATCH /v1/webhooks/:slug` | Change `url`, `events`, `enabled` or `batch_interval_minutes` (`null` restores the default) |
| `POST /v1/webhooks/:slug/rotate` | A new signing secret, returned this once; the old one stops working immediately |
| `GET /v1/webhooks/:slug/deliveries` | The latest 50 deliveries, newest first: `event`, `status` (`pending`, `delivered`, `dead`), `attempts`, `next_attempt_at`, `last_error`, `created_at`, `delivered_at`, `payload` |
| `DELETE /v1/webhooks/:slug` | Delete the endpoint; its undelivered events are dropped |

- Secrets are stored encrypted (`ENCRYPTION_KEY` must be set; without it creating or rotating answers `503`) and are never returned after creation or rotation.
- `batch_interval_minutes` (1 to 1440, default 15) is the window of the batched `message.pending_approval` event for that endpoint.
- The analytics sink (slug `analytics`) is listed with `read_only: true` and its deliveries can be read; it is changed through `settings.analytics` in a config document. The slug `analytics` cannot be used for a webhook.
- Webhooks are part of the [config document](CONFIG.md): every change here bumps the product's `config_version`, and a document that lists `webhooks` replaces these changes on its next apply.

## Analytics sink

`settings.analytics` sends one flat event per lifecycle step to an analytics tool, keyed by your user id (the contact's `external_id`), through the same outbox:

| Analytics event | From |
|---|---|
| `flow_enrolled` | `flow.enrolled` |
| `flow_exited` (`reason`) | `flow.exited` |
| `email_sent` | `message.sent` |
| `email_clicked` | `message.clicked` |
| `email_bounced` | `message.bounced` |
| `email_complained` | `message.complained` |
| `email_unsubscribed` | `contact.unsubscribed` |
| `approval_decided` (`decision`) | an approval or rejection |
| `choose_decided` | reserved for the `choose` step (not released yet) |

Opens are not sent: they are unreliable (mail privacy proxies open everything).

```json
{ "event": "email_sent", "ts": "2026-11-20T10:00:00.000Z", "user_id": "user_123", "product": "acme",
  "message_id": "...", "action_type": "welcome", "step": 1, "flow": "welcome", "topic": "lifecycle" }
```

- `sink: "statsraven"`: `POST {endpoint}/ingest?source=claros` with `Authorization: Bearer {secret}` (a StatsRaven ingest token). `endpoint` is the StatsRaven address, for example `https://stats.example.com`.
- `sink: "webhook"`: `POST {endpoint}` with the flat event as the body, signed like a webhook when `secret` is set.

Links in mail can carry UTM parameters and `clr_cid=<message id>` so the analytics tool can join a visit to the email: see `settings.link_tracking` in [config as code](CONFIG.md#link-tracking).
