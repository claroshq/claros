# Topics and consent

> Status: unreleased (planned for v0.8). Released versions up to v0.7 have no topics: every message carries List-Unsubscribe and an unsubscribe stops all mail of the product.

Topics let a contact choose which kinds of email they receive from a product, for example "Product news" or "Onboarding tips", without unsubscribing from everything. A product without topics behaves exactly as before.

## Topic kinds

Every topic has a kind:

| Kind | Use it for | Topic unsubscribe | List-Unsubscribe headers |
|---|---|---|---|
| `marketing` | newsletters, announcements | blocks the topic's mail | yes |
| `lifecycle` | onboarding, nudges, re-engagement | blocks the topic's mail | yes |
| `transactional` | receipts, account and security mail | ignored | no |

The suppression list always wins: a suppressed address (product-wide unsubscribe, hard bounce, complaint, manual suppression) receives nothing, transactional topics included.

A topic is subscribed by default. Clear `default_subscribed` for opt-in topics: a contact then receives that topic's mail only after subscribing.

A topic with `mirror_only` set only mirrors a consent your app keeps elsewhere (a newsletter tool, for example): contacts' statuses for it are kept (identify `topics`, the preference page) and reported by webhooks, but no flow may send on it. Creating or editing a flow on it is refused, and setting `mirror_only` on a topic a flow uses answers 409.

An identify call whose `topics` changes a contact's effective status for a topic emits `contact.subscribed` or `contact.unsubscribed` ([webhooks](WEBHOOKS.md)).

## Creating topics

In the dashboard: Settings, Topics. Over the API (owner role for writes):

```bash
curl -X POST https://claros.example.com/v1/topics \
  -H 'Content-Type: application/json' -b 'claros_session=...' \
  -d '{"slug": "product-news", "name": "Product news", "kind": "marketing"}'
```

- `GET /v1/topics` lists the product's topics.
- `POST /v1/topics` creates one: `slug` (1 to 63 characters of `a-z`, `0-9`, `_` and `-`, fixed after creation), `name`, `kind`, optional `description`, `default_subscribed` (default `true`) and `mirror_only` (default `false`). A duplicate slug answers 409.
- `PATCH /v1/topics/:id` changes `name`, `kind`, `description`, `default_subscribed` or `mirror_only`.

## Giving a flow a topic

Pick the topic in the flow editor, or set `topic_id` on `POST /v1/flows` and `PATCH /v1/flows/:id` (`null` removes it). Messages take the flow's topic when they are created; messages created earlier keep the topic they had (none).

## How a send is gated

At send time, after the suppression list, the drain checks the message's topic:

- the contact unsubscribed from the topic, or has no choice recorded and the topic is opt-in: the message is suppressed with `status_reason = topic_unsubscribed`;
- otherwise the message is sent.

Transactional topics skip this check.

## Setting consent from your product

Send the contact's choices with identify, keyed by topic slug:

```json
{
  "userId": "user_123",
  "traits": {
    "email": "jane@example.com",
    "topics": { "product-news": false, "beta-program": true }
  }
}
```

`true` subscribes, `false` unsubscribes (recorded with source `identify`). Slugs that are not topics of the product and values that are not booleans are ignored. The `topics` trait is also stored in the contact's properties like any other trait. Product-wide unsubscribes stay on the suppression list (`POST /v1/suppressions`).

A contact's topic statuses appear on their page in the dashboard and in `GET /v1/contacts/:id` as `topics`: one entry per topic with `status` (`subscribed` or `unsubscribed`), `default` (`true` when no choice is recorded and the topic default applies), `source` and `updated_at`.

## Unsubscribe links

- Messages with a marketing or lifecycle topic carry RFC 8058 one-click headers (`List-Unsubscribe`, `List-Unsubscribe-Post`) whose link unsubscribes that topic only.
- Messages without a topic carry the headers as before; one-click unsubscribes the whole product.
- Messages with a transactional topic carry no List-Unsubscribe headers. Their footer, with the postal address and the unsubscribe link, stays.

The unsubscribe page (the footer link) lists the product's marketing and lifecycle topics with checkboxes, checked for the ones the contact receives, plus "Unsubscribe from all", which adds the address to the suppression list. Opening the page never changes anything; only submitting it does.

Links in mail sent before topics existed keep working: they unsubscribe the whole product, as they always did.
