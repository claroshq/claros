# Flows: triggers, steps and what a step can use

> Since v0.8. Everything here works on Postgres + Node and on Cloudflare Workers + D1.

A flow is a trigger and a list of steps. This page covers the trigger types, the step fields, and the step features that let a real product's mail use its own data: dates, context sources, the knowledge base, named links, and the `choose` step. The fields are written in a [config document](CONFIG.md); `GET /v1/flows/:id` shows them on stored flows.

## Triggers

| Type | Enrolls a contact when |
|---|---|
| `event` | The app sends the event (`{"event": "signed_up"}`), or one of several (`{"event": ["subscription_upgraded", "subscription_downgraded"]}`) |
| `lifecycle_transition` | The contact moves to a lifecycle state (`{"from"?: "engaged", "to": "at_risk"}`; without `from`, from any state) |
| `segment` | The contact is in a retention-grid cell (`{"tenure_bucket": "growing", "recency_bucket": "idle"}`), or in one of the listed lifecycle states and engagement depths (`{"lifecycle_states": ["engaged", "at_risk"], "engagement_depths"?: ["power", "regular"]}`). The scan checks segment flows every 15 minutes |
| `manual` | You enroll contacts: `POST /v1/flows/:id-or-slug/enroll` (see [Manual enrollment](#manual-enrollment)) |
| `date_property` | A date trait is due: `{"property": "trial_ends_at", "offset": "-3d", "send_at_local"?: "09:00", "where"?: [conditions]}` |
| `date_schedule` | A date trait anchors a series of sends: `{"anchor": "first_paid_at", "offsets": ["1d", "3d", "7d"], "repeat"?: "30d", "max_sends": 7, "send_at_local"?: "09:00", "where"?: [conditions]}` |

Every trigger type takes `where`: [audience conditions](CONFIG.md#conditions) the contact must meet when it would be enrolled (one condition, a combinator, or a list that must all hold). A malformed `where` never enrolls. Trigger keys a type does not read are reported as warnings by the config apply.

### Flow classes

| `flow_class` | Concurrency | Frequency caps and send windows |
|---|---|---|
| `nurture` (default) | At most one active nurture flow per contact; a higher-priority one takes the slot | Respected |
| `critical` | Runs alongside every other flow | Bypassed (`critical_bypass_throttle`) |
| `scheduled` | Runs alongside every other flow, never takes the nurture slot | Respected |

`scheduled` is meant for long-running date schedules (a monthly nudge for months) that should not block the contact's other nurture flows but must still respect the product's caps.

### Manual enrollment

`POST /v1/flows/:id-or-slug/enroll` (a member session, or an [admin key](API_KEYS.md) with the `config` scope) enrolls contacts in an active `manual` flow:

- `{"external_ids": ["u_1", "u_2"]}` (at most 500): these contacts.
- `{"limit"?: 500, "cursor"?: "..."}`: every contact that meets the trigger's `where` (needed), one page per call (at most 1000); call again with `next_cursor` until it is `null`.

Each contact goes through the trigger's `where` and the usual guards (suppression, class concurrency, re-entry). The answer counts them: `{"enrolled": 12, "skipped": {"where": 30, "already_enrolled": 1}, "next_cursor": "..."}` (`not_found` lists unknown external ids).

### Date triggers

Declare the identify traits that hold dates in `settings.date_traits` (ISO-8601 strings, or epoch seconds or milliseconds). Claros keeps an index of them, updated on every identify and rebuilt when the list changes; the scan reads it every 15 minutes.

- **Slots.** Slot k of a schedule is due at anchor + `offsets[k]`; after the listed offsets, every `repeat`, up to `max_sends` slots (without `repeat`, the listed offsets only). A `date_property` trigger is one slot at anchor + `offset` (negative offsets are before the date).
- **Local time.** With `send_at_local`, a slot is due at that time on its local day, in the contact's `timezone` trait, else the product's timezone (`throttle.tenant_timezone`), else UTC.
- **Once per date.** A contact is enrolled once per (flow, contact, date value), when the first slot is due. Re-entry policies do not apply to date flows; the date value does. A slot more than 24 hours old is never sent (a date backfilled far in the past sends nothing); the schedule moves on to its next slot.
- **Moving the date.** When the trait changes or is removed, the enrollment for the old date exits with reason `date_changed` and its unsent messages are cancelled (`status_reason = date_changed`). The new date enrolls when its slot is due. The step condition `{"date_unchanged": true}` checks the same thing explicitly.
- **Conditions at every send.** In a schedule, the step for slot k is the step with the highest `order` not above k (one step serves every slot). Its `condition` and the trigger's `where` are checked before each slot; a slot whose conditions fail is skipped. Plan `exit_conditions` end the series (for example "exit when `icp_configured` becomes true").
- A nurture-class date flow holds the contact's one nurture slot for as long as the enrollment is active (a long schedule blocks other nurture flows for that contact). Use `flow_class: "scheduled"` for long schedules: they run alongside nurture flows and still respect caps and send windows. Date schedules may use any class; the config apply warns about nurture-class schedules.

## Step fields

| Field | Meaning |
|---|---|
| `order`, `action_type`, `delay` | Required. `delay` (`0m`, `2h`, `3d`) counts from the previous step; date schedules use their slots instead |
| `window_policy` | `immediate` or `respect_window` |
| `template_ref` | A template slug: fixed content (no LLM call) |
| `brain_instruction` | Instruction for AI-drafted content. Template variables work here too (`{{links.icp_url}}`, `{{contact.properties.plan_tier}}`, `{{context.leads...}}`) |
| `condition`, `exit_condition` | See [conditions](CONFIG.md#conditions): one condition, a combinator (`all`, `any`, `not`), or a list that must all hold |
| `from_name` | Sender display name for this step's mail (a persona, "Sam from Acme"); the address stays the transport's verified sender |
| `reply_to` | Reply-To address for this step's mail |
| `eyebrow` | A short label above the message body ("QUICK TIP"), in the product's accent color; a choose candidate may set its own |
| `preheader` | Hidden inbox preview text of the HTML mail |
| `allowed_links` | Names from `settings.links` this step may use: the drafting model gets only these, and the [link allowlist](#links-and-text-rules) accepts only these (plus URLs a context source returned); a choose candidate may set its own |
| `single_cta` | At most one link besides the footer and unsubscribe links: the model is told so, and a draft with more is blocked (`status_reason = single_cta`); a fixed template with more is refused by the config apply |
| `expires_after` | `2d`, `12h`: a message of this step that is not sent this long after it was created is cancelled with reason `expired` (approval queue included) |
| `context`, `on_empty`, `on_error` | [Context sources](#context-sources) |
| `kb_select` | [Knowledge base selection](#knowledge-base-selection) |
| `type`, `candidates`, `allow_none` | [The choose step](#the-choose-step) |

## Context sources

A step can ask the product for data at render time: `"context": [{"source": "leads", "mode": "inferred", "limit": 3}]`. The source is declared in `settings.data_sources` (`url`, `secret` or `secret_ref`, `timeout_ms`, default 5000).

Claros sends `POST <url>` with the body

```json
{ "source": "leads", "mode": "inferred", "limit": 3, "product": "fundup",
  "contact": { "external_id": "u_42", "email": "a@example.com", "traits": { "plan_tier": "pro" } },
  "flow": { "slug": "icp_setup_nudge" }, "step": { "order": 1 }, "message_id": "..." }
```

signed with [Standard Webhooks](WEBHOOKS.md#verifying-signatures) headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`) and the source's secret. The source answers `{"data": {...}, "empty": false}` (`empty` defaults to "data is null, `{}` or `[]`").

- The data is stored on the message (`context_snapshot`), shown in approvals, and available to templates as `{{context.leads...}}` with Mustache sections: `{{#context.leads.leads}}<a href="{{url}}">{{name}}</a>{{/context.leads.leads}}` repeats for each item, `{{^context.leads.leads}}...{{/context.leads.leads}}` renders when there is nothing. AI-drafted steps get it as context data.
- `on_empty`: `send` (default) or `skip` (the message is skipped, reason `context_empty`).
- `on_error` (timeout, non-2xx, invalid JSON, no usable secret): `defer` (default; the message waits and is retried by the recovery job), `skip`, or `fail`.
- Return absolute URLs. Links on your tracked domains get the [link tracking](CONFIG.md#link-tracking) parameters when the mail is sent; URLs that came from the context source pass the link allowlist.

## Knowledge base selection

`"kb_select": {"category": "tip_trick", "exclude_used": true, "pick": "oldest_unused", "tags_any_from_trait": "plan_tier"}` picks one active [knowledge base](KB.md) entry of the category for the message:

- `exclude_used` (default `true`): an entry is never sent twice to a contact. Messages that were sent, are on their way or wait for approval count, and so does [imported history](IMPORT.md).
- `pick`: `oldest_unused` (default) or `best_match` (the entry sharing the most words with the step's instruction and action type).
- `tags_any_from_trait`: the contact trait (a string or a list) names the tags an entry must carry one of; entries without tags are general and stay eligible.
- No eligible entry: the message is skipped (reason `kb_exhausted`).

The entry goes to the drafting model as the topic of the email; fixed templates can use `{{kb.title}}` and `{{kb.content}}`. Pinned entries always reach the drafting model (oldest first, about 2,000 tokens).

## Template variables

Fixed templates and brain instructions use Mustache-style variables: `{{contact.first_name}}` (with a default: `{{contact.first_name|there}}`), `{{contact.properties.plan_tier}}` (alias `{{traits.plan_tier}}`), `{{tenant.name}}`, `{{flow.name}}`, `{{links.billing_url}}`, `{{context.leads...}}`, `{{kb.title}}`, `{{brain.opening}}`, and `{{event.new_plan}}`: a property of the event that enrolled the contact (event-triggered flows; the properties are kept on the enrollment, up to 16 KB of JSON).

Sections show a block only when a value is set (`{{#traits.founding_price}}Your founding price stays.{{/traits.founding_price}}`) or only when it is not (`{{^traits.founding_price}}...{{/traits.founding_price}}`); over a list they repeat for each item. One template with sections replaces per-variant templates picked by step conditions.

## Links and text rules

`settings.links` names the product's URLs (`{"icp_url": "https://..."}`): templates and brain instructions use them as `{{links.icp_url}}`, and the drafting model gets the list and is told to use only those URLs.

Once a product declares `links` or `link_tracking.domains` (or the step sets `allowed_links`), every AI draft is checked after drafting: an http(s) URL that is not one of the named links (extra query parameters allowed), not on a tracked domain (or subdomain) and not returned by a context source blocks the draft. The message fails with `status_reason = link_not_allowed`; the draft and the offending URLs stay visible in approvals. Products without either keep the earlier behaviour.

`settings.brain.text_rules` run on every AI draft after drafting and before the value gate: `{"find": "...", "replace": "..."}` rewrites the subject and body, `{"forbid": "..."}` fails the message with `status_reason = text_rule_forbidden`. Plain string rules are writing rules given to the model. `settings.brain.guidelines` is appended to the drafting and value-gate instructions; `locale` sets the drafting language.

## AI opening line in a fixed template

A fixed template with `{{brain.opening}}` gets one AI-drafted opening line (at most 240 characters, no links, text rules applied), stored on the message and shown in approvals. Templates without the slot make no LLM call.

## The choose step

A choose step lets the model pick which of several actions to send:

```json
{ "order": 1, "action_type": "nurture", "delay": "0m", "type": "choose", "allow_none": true,
  "candidates": [
    { "action_type": "onboarding_rescue", "kb_select": { "category": "onboarding_rescue" }, "when": [{ "trait": { "key": "stage", "op": "eq", "value": "at_risk" } }] },
    { "action_type": "tip_trick", "kb_select": { "category": "tip_trick" }, "cooldown": "14d" },
    { "action_type": "curated_leads", "context": [{ "source": "leads", "mode": "normal" }], "template_ref": "leads" }
  ] }
```

A candidate has `action_type` and optionally `when` (conditions), `kb_select`, `context`, `cooldown`, `template_ref` or `brain_instruction` (default: the step's).

1. **Filters first, in code.** A candidate is dropped when the contact is unsubscribed from the flow's topic (`consent`), at the daily or weekly cap (`throttle`; critical flows that bypass caps skip this), received this action within `cooldown` (`cooldown`; imported history counts), fails `when` (`when`), has no unused entry for `kb_select` (`kb_exhausted`), or a context source returns nothing (`context_empty`) or fails (`context_error`).
2. **Nothing eligible:** the step records `none` without an LLM call and the message is skipped.
3. **The model picks** one eligible candidate or `none` (`allow_none: false` forbids `none`). An answer outside the eligible set is rejected and asked once more, then recorded as `none`.
4. The pick is drafted like a normal step (its template, or its instruction, KB entry and context data). The choice, the eligible set, the filtered-out candidates with reasons and the model's reason are stored on the message (`choose`) and shown in approvals, and a `choose_decided` event goes to the [analytics sink](WEBHOOKS.md#analytics-sink).
5. **Regenerate with a forced action** (`POST /v1/messages/:id/regenerate {"action_type": ...}`) may force any declared candidate; its filter result is shown as a warning.

A product without an LLM configuration cannot use choose steps: the config apply refuses them.

## Editing flows in the dashboard

The flow editor edits every trigger type (with `where`), the flow class, and the plan: steps with the fields above, choose candidates, context sources, `kb_select`, `expires_after`, conditions with `all` / `any` / `not` (or as JSON), and plan exits. It saves through `PUT /v1/flows/:id/steps` (a member session, or an admin key with the `config` scope), which validates the steps like a config document and stores them as the compiled plan.
