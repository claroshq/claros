# Config as code

> Status: unreleased (planned for v0.8).

A product's flows, templates, topics, transport routing, settings and webhooks can live in one JSON file in your repository, reviewed like code and applied with one command. The file is validated against [docs/reference/claros.config.schema.json](../reference/claros.config.schema.json) (add `"$schema"` to the file for editor completion).

```bash
export CLAROS_URL=https://claros.example.com
export CLAROS_ADMIN_KEY=clr_ak_...          # admin key with the "config" scope
npx claros apply -f claros.config.json --dry-run   # list the changes
npx claros apply -f claros.config.json             # apply them
```

`claros apply` calls `PUT /v1/config` (`?dry_run=1` for `--dry-run`). Instead of `CLAROS_URL`, `--url` works, or `--name <instance>` for an instance deployed with `claros deploy`; instead of `CLAROS_ADMIN_KEY`, `--key`. The product is the admin key's product (see [API keys](API_KEYS.md)). An owner's dashboard session can call the endpoint too.

## Rules

- Items are matched by `slug` (transports by name). A listed item is created or updated; an unlisted item is left alone.
- `"prune": true` removes unlisted items of the kinds the document lists: topics, templates and webhooks are deleted, flows are archived (their slug is cleared, history stays). A topic still used by a flow is never deleted (the apply fails with the reason). Templates still used by a flow that stays are kept.
- The apply is atomic: every change is written, or none is. It bumps the product's `config_version`. Two applies racing: the second answers `409`; run it again.
- Applying the same document twice changes nothing the second time (empty diff, same `config_version`).
- Errors (an unknown topic or template, a transport name that does not exist, a Cloudflare transport as the default route) are reported together and nothing is written.
- Secrets in the file (`webhooks[].secret`, `settings.analytics.secret`) are encrypted at rest. Prefer leaving webhook secrets out: Claros generates one and the apply prints it once.
- `GET /v1/config` returns the product's current configuration as a document (without secrets), a starting point for the file.

The response lists each change:

```json
{ "dry_run": false, "config_version": 7,
  "changes": [ { "kind": "flow", "key": "dunning", "action": "update", "fields": ["name"] },
               { "kind": "webhook", "key": "app", "action": "create" } ],
  "webhook_secrets": { "app": "whsec_..." } }
```

## A complete example

```json
{
  "$schema": "https://github.com/claroshq/claros/blob/main/docs/reference/claros.config.schema.json",
  "version": 1,
  "settings": {
    "locale": "en",
    "postal_address": "Acme Inc., 1 Main Street, Springfield",
    "brand": { "brand_name": "Acme", "accent_color": "#2f6fed", "reply_to": "support@acme.example" },
    "throttle": { "max_emails_per_user_per_week": 4, "send_window_start": "09:00", "send_window_end": "18:00" },
    "links": { "billing_url": "https://app.acme.example/billing", "setup_url": "https://app.acme.example/setup" },
    "link_tracking": {
      "domains": ["acme.example"],
      "params": { "utm_source": "claros", "utm_medium": "email", "utm_campaign": "{{flow.slug}}", "utm_content": "step-{{step.order}}" },
      "click_id": true
    },
    "brain": { "guidelines": "Short, plain sentences. One call to action.", "text_rules": ["Never promise discounts."] },
    "date_traits": ["trial_ends_at", "first_paid_at"],
    "activation_events": ["project_created"],
    "analytics": { "sink": "statsraven", "endpoint": "https://stats.acme.example", "secret": "INGEST_TOKEN" }
  },
  "topics": [
    { "slug": "account", "name": "Account", "kind": "transactional" },
    { "slug": "lifecycle", "name": "Tips and onboarding", "kind": "lifecycle" },
    { "slug": "product_updates", "name": "Product updates", "kind": "marketing", "default_subscribed": false }
  ],
  "templates": [
    {
      "slug": "dunning-1",
      "name": "Payment failed",
      "subject": "Your payment did not go through",
      "body_html": "<p>Hi {{contact.first_name}}, please <a href=\"https://app.acme.example/billing\">update your card</a>.</p>",
      "body_text": "Hi {{contact.first_name}}, please update your card: https://app.acme.example/billing"
    }
  ],
  "transports": { "routing": { "transactional": "cf-account", "default": "resend-main" } },
  "flows": [
    {
      "slug": "dunning",
      "name": "Dunning",
      "flow_class": "critical",
      "approval_mode": "auto",
      "topic": "account",
      "trigger": { "type": "event", "event": "payment_failed" },
      "steps": [
        { "order": 1, "action_type": "dunning", "delay": "0m", "window_policy": "immediate", "template_ref": "dunning-1" }
      ],
      "exit_conditions": [{ "event": "payment_succeeded" }],
      "reentry": { "policy": "every_time" }
    },
    {
      "slug": "subscribe-nudge",
      "name": "Subscribe nudge",
      "topic": "lifecycle",
      "trigger": {
        "type": "event",
        "event": "pricing_viewed",
        "where": [
          { "trait": { "key": "plan_tier", "op": "eq", "value": "free" } },
          { "history": { "flow": "subscribe-nudge", "within": "30d", "op": "none" } }
        ]
      },
      "steps": [
        {
          "order": 1, "action_type": "upgrade_nudge", "delay": "1h",
          "brain_instruction": "Remind them what the paid plan adds, with the billing link.",
          "condition": { "trait": { "key": "plan_tier", "op": "eq", "value": "free" } }
        }
      ],
      "exit_conditions": [{ "event": "subscription_started" }]
    },
    {
      "slug": "winback",
      "name": "Win back",
      "topic": "lifecycle",
      "trigger": { "type": "lifecycle_transition", "to": "churned" },
      "prompt": "Two emails to churned users, 3 days apart. Stop when they come back.",
      "status": "paused"
    }
  ],
  "webhooks": [
    { "slug": "app", "url": "https://app.acme.example/internal/claros/webhook",
      "events": ["contact.unsubscribed", "contact.suppressed", "message.pending_approval"] }
  ]
}
```

`transports.routing` names transports set up in the dashboard (Settings, Transports): their credentials stay out of the file. Cloudflare Email Service sends transactional mail only, so it can be the `transactional` route but never the `default` one (see [Transports](TRANSPORTS.md)).

## Flows

| Field | Default | Notes |
|---|---|---|
| `slug`, `name` | required | |
| `trigger` | required | `{"type": "event", "event": "...", "where": [conditions]}`, `{"type": "lifecycle_transition", "from"?: "...", "to": "..."}`, `{"type": "segment", ...}`, `{"type": "manual"}` |
| `steps` | | The plan, written out: `order`, `action_type`, `delay` (`0m`, `2h`, `3d`), `window_policy` (`immediate`, `respect_window`), `template_ref` (a template slug: fixed content) or `brain_instruction` (AI-drafted), `condition`, `exit_condition` |
| `prompt` | | Instead of `steps`: a natural-language flow, compiled by your LLM after the apply (and again when the prompt changes) |
| `exit_conditions` | none | Plan-level exits |
| `status` | `active` for a new flow; unchanged otherwise | `active`, `paused`, `draft` |
| `content_mode` | `fixed_content` when every step has a `template_ref`, else `ai_drafted` | |
| `approval_mode` | `require` | `auto` skips the [approval queue](APPROVALS.md) |
| `flow_class` | `nurture` | `critical` flows run alongside others and bypass frequency caps |
| `priority` | `0` | |
| `reentry` | `{"policy": "cooldown", "cooldown_days": 30}` | `once`, `cooldown`, `every_time` |
| `topic` | none | A topic slug |

### Conditions

Step `condition` (proceed only if true), step `exit_condition`, plan `exit_conditions` and event-trigger `where` take these shapes, besides the lifecycle and event shapes a compiled prompt produces (`{"lifecycle_state": "..."}`, `{"lifecycle_state_not": "..."}`, `{"event_since_step": "..."}`, `{"event": "..."}`):

| Shape | True when |
|---|---|
| `{"trait": {"key": "plan_tier", "op": "eq", "value": "pro"}}` | The contact's identify trait matches. `op`: `eq`, `neq`, `in` (value is a list), `exists`, `not_exists`, `gt`, `lt` (numbers or ISO dates). `key` may be a dotted path (`company.size`). |
| `{"history": {"flow": "welcome", "within": "7d", "op": "none"}}` | Messages sent to the contact in this product, filtered by `flow` (slug), `action_type` or `topic` (slug), in the last `within` (`30m`, `12h`, `7d`; absent = ever): `none`, `any`, or `count_lt` with `value` |
| `{"first_contact": true}` | Nothing was ever sent to the contact in this product (`false`: something was) |

An exit condition `{"trait": {"key": "icp_configured", "op": "eq", "value": true}}` exits the flow once the trait becomes true. Entries in `where` must all hold; an event trigger whose `where` is malformed never enrolls.

## Settings

| Key | Meaning |
|---|---|
| `brand`, `throttle`, `postal_address` | As in the dashboard settings |
| `links` | Named links (`{"billing_url": "https://..."}`) |
| `link_tracking` | See below; `null` removes it |
| `locale` | The product's locale (`en`, `de-AT`); `null` clears it |
| `brain` | `guidelines` (text) and `text_rules` (list) for drafted content |
| `data_sources`, `date_traits`, `activation_events` | Stored for the features that read them |
| `analytics` | The [analytics sink](WEBHOOKS.md#analytics-sink): `sink` (`statsraven`, `webhook`), `endpoint`, `site_key`, `secret`; `null` removes it |

A settings key in the document replaces that key; keys the document does not mention are kept.

### Link tracking

With `link_tracking`, links in the body of each message that point to one of `domains` (or a subdomain) get the `params` and, with `click_id`, `clr_cid=<message id>`. Placeholders: `{{flow.slug}}` (the flow name when the flow has no slug), `{{flow.name}}`, `{{step.order}}`, `{{message.id}}`. A parameter the link already has is never overwritten; other domains, `mailto:` links and the unsubscribe and footer links are never changed. The stored message is not modified; links are tagged when the message is sent.

## Webhooks

`webhooks` lists signed webhook endpoints: `slug`, `url`, `events`, optional `enabled` (default `true`) and `secret`. See [Webhooks](WEBHOOKS.md) for the events, payloads and signature verification.
