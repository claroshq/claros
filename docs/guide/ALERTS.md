# Alerts and health

> Since v0.8. Versions up to v0.7 write failures to the logs only.

Claros records operational failures, groups repeats, and mails a person when something needs attention. It works the same on Postgres + Node and on Cloudflare Workers + D1. Nothing has to be configured: an install that never sets an alert recipient mails the oldest instance admin, and without a usable transport alerts show only on the Health page and in the logs.

## What is recorded

Every failure is an event with a severity (`warning`, `error` or `critical`), the product it is about (when it is about one) and a message.

| Kind | When | Severity |
|---|---|---|
| `dead_letter` | A job failed on every retry: the Workers dead letter queue, or a pg-boss job on its last retry. | error |
| `job_failed` | A job threw an exception (each attempt). | error |
| `tick_late` | A periodic job (scan, drain, content, reap, ...) has not completed for three of its intervals. Checked every 5 minutes. Jobs that never ran are not judged. | error |
| `send_error_rate` | More than 20% of a product's sends on one transport failed over the last 15 minutes, with at least 10 attempts. Failed sends and sends stuck on a transient provider error count. Checked in the drain tick. | error |
| `send_auth_error` | The provider refused a transport's credentials (Resend or Cloudflare HTTP 401/403, SMTP 530/535). | critical |
| `drain_config` | The drain left approved messages unsent because the product has no usable transport, or `UNSUBSCRIBE_SIGNING_KEY` is not set. | critical |
| `webhook_failures` | 10 or more Resend webhook signature or processing failures for a product in 15 minutes. Requests for a product without a webhook secret are not counted. | error |
| `llm_error_rate` | More than 20% of a product's LLM calls (decide, draft, assess) failed in a 15-minute window, with at least 5 calls. | warning |

Repeats of the same failure share a fingerprint: the kind, the product and the message with ids, numbers and timestamps removed. One fingerprint is one alert, with a count of its occurrences.

Events are kept 30 days.

## Alert mail

- An `error` or `critical` alert is mailed within one content tick (at most 5 minutes) after its first occurrence.
- Repeats mail at most once an hour, saying how many more occurrences there were since the last mail.
- At most 10 alert mails per hour per install. When more are due, one "alert storm" mail lists them and they are not mailed one by one; they appear on the Health page and in the next digest.
- An alert with no new occurrence for 60 minutes is resolved. A critical alert that was mailed gets a short resolved mail.
- `warning` alerts are not mailed; they show on the Health page and in the digest.
- A muted alert is not mailed until the mute ends.
- A failed alert mail is logged and never raises another alert.

Alert mail is transactional: plain text with a simple HTML part, no List-Unsubscribe headers, no topic rules. It is sent through the transactional route of a product's transports (see [Transports](TRANSPORTS.md)): the product named in `alerts.via_product`, else the oldest product with a usable transport. A `cloudflare` transport may send it.

### Daily digest

Every day at 07:00 UTC, the digest lists the open alerts, the last 24 hours of events grouped by fingerprint, the number of failed jobs, sent and failed messages per product, and pending approvals with the oldest one. It is not sent when there are no open alerts, no events and no pending approvals.

## Settings

Instance settings (instance admins), in the dashboard under Settings, Health, or over the API:

| Key | Value | Default |
|---|---|---|
| `alerts.email` | Recipient address, or `""` | The oldest active instance admin |
| `alerts.enabled` | `true` or `false` | `true` |
| `alerts.via_product` | Product slug, or `""` | The oldest product with a usable transport |

```bash
curl -X PUT https://claros.example.com/v1/instance/settings/alerts.email \
  -H 'Content-Type: application/json' -b 'claros_session=...' \
  -d '{"value": "ops@example.com"}'
```

With `alerts.enabled` set to `false`, failures are still recorded and listed on the Health page; nothing is mailed, the digest included.

## Health page and API

Settings, Health (instance admins) shows the open alerts with Resolve and Mute actions, the last completed run of every periodic job, the events of the past 7 days and the alert settings.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/v1/instance/health` | | `alerts.open`, `alerts.recently_resolved`, `events`, `ticks` (`name`, `last_run_at`, `interval_minutes`, `late`), `failed_jobs_24h`, `settings` |
| POST | `/v1/instance/alerts/:fingerprint/resolve` | | `{ alert }` |
| POST | `/v1/instance/alerts/:fingerprint/mute` | `{ "hours": 1..720 }` | `{ alert }` |

URL-encode the fingerprint in the path. A resolved alert that occurs again opens as a new alert and is mailed again.

Each periodic job records its last completed run as the instance setting `tick.<name>`; the windowed counters for webhook and LLM failures are the settings `webhook.window.<product id>` and `llm.window.<product id>`.
