# FAQ and Troubleshooting

Real questions, concrete actions. If your problem is not here, file an issue with the output of `claros doctor`.

## Accounts and access

### I lost access to the only admin account

The `claros` CLI talks to the database directly and does not need a working login.

```bash
# See who exists:
docker compose exec app claros user list default

# Mint a login link for any existing user (works even with no transport configured):
docker compose exec app claros login-link admin@example.com

# Or create a fresh owner and log in as them:
echo '{"email":"recovery@example.com","role":"owner"}' \
  | docker compose exec -T app claros user create default
docker compose exec app claros login-link recovery@example.com
```

If the seeded admin email itself was wrong (typo at first boot), use `user create` to add the correct address as owner; the last-owner protections only block removing the final owner, not adding new ones.

### I am not receiving the login email

Login links are sent through your configured transport. If you have no transport yet (or it is broken), the fallback depends on `NODE_ENV`:

- `NODE_ENV=development` (the compose default): the link is printed to the app log. `docker compose logs app | grep -A5 "MAGIC LINK"`
- `NODE_ENV=production`: no console fallback. Use `claros login-link <email>`, which generates a link directly against the database.

Then fix the transport so future logins arrive by email: `claros transport show default`, and send yourself a test email from Settings → Transport.

### How do I add a teammate?

Settings → Team → invite (owner only). The invite email goes through your transport and expires in 7 days. With no transport, use `claros user create` + `claros login-link` as shown above.

## Sending problems

### My emails are not sending

Work this list in order; each item blocks everything below it:

1. **Transport configured and active?** `docker compose exec app claros transport show default`
2. **Postal address set?** `docker compose exec app claros postal-address show default` (CAN-SPAM gate; nothing sends without it)
3. **`UNSUBSCRIBE_SIGNING_KEY` set?** The drain fails closed without it. Check `docker compose exec app claros doctor`
4. **`ENCRYPTION_KEY` set and unchanged?** If it was rotated after credentials were saved, decryption fails and the transport cannot be used. Re-enter the credentials with `claros transport set`
5. **Production URL sane?** With `NODE_ENV=production`, the drain refuses loopback or non-HTTPS `BASE_URL`
6. **Messages waiting on approval?** Check **Approvals** in the dashboard. AI-drafted flows hold every message until approved
7. **Throttled or outside the send window?** Defaults: 1 email per contact per day, 2 per week, 48h minimum gap, 09:00-17:00 weekdays. A deferred message shows its scheduled time on the message
8. **Suppressed?** Check Sent → Suppressions for the address (unsubscribe, bounce, complaint, or import)
9. **Daily limit hit?** A transport `daily_limit` defers the rest of the day by 24 hours

The single best diagnostic: `docker compose exec app claros doctor`, plus `docker compose logs app | grep -i drain`.

### Nothing happens after I send an event

1. **Is there an active, compiled flow whose trigger matches?** All three are required: status `active`, compile status `ready`, and the trigger event name spelled exactly as your app sends it. Event names are case-sensitive strings; `signed_up` and `signed-up` are different events
2. **Did you send `identify` instead of `track`?** Identify calls never trigger flows. Only `track` events (and lifecycle transitions, and retention-grid segments) enroll contacts
3. **Event-triggered flows are near-instant, but lifecycle-transition and segment triggers only run on the 15-minute scan.** Wait one scan cycle before concluding it is broken
4. **Is the contact already in a nurture flow?** One active nurture flow per contact. The new one either evicts it (higher priority) or is blocked
5. **Re-entry policy?** A `once` flow will not re-enroll a contact who has been through it
6. **Is the contact suppressed or missing an email address?** Enrollment is blocked for suppressed addresses; messages cannot be sent to contacts with no email

Verify ingestion itself is healthy on the Integrate page (it shows recent event volume) and see [INGESTION.md](./INGESTION.md#7-verifying-your-integration) for the verification loop.

### The AI features do nothing

Three independent requirements:

1. **An LLM provider is configured:** Settings → LLM, or `claros llm show default`. The credentials are verified against the provider at save time, so a saved config is a working config
2. **`ENCRYPTION_KEY` is set:** without it the saved credentials cannot be decrypted and every AI operation fails at runtime
3. **For a specific flow: it has been compiled.** Prompt-defined flows do nothing until you press Compile. A failed compilation is shown on the flow with the reason

What works with no LLM key at all: ingestion, contacts, lifecycle, the library flow, fixed-content flows you write yourself, approvals, suppression, analytics. What needs a key: compiling prompts, AI-drafted content, AI step-draft assistance, knowledge base embeddings.

### How do I send faster (or slower)?

Settings → Pace, or `PUT /v1/settings/throttle` (owner). Defaults and ranges are tabulated in [INSTALLATION.md](./INSTALLATION.md#throttle-and-send-window). The knobs: per-contact daily/weekly caps, minimum gap between emails, send-window hours/days/timezone, and `batch_size_per_tick` (max messages per tenant per drain tick, default 10, range 1-100).

Fixed constraints: the drain sweep runs every 15 minutes (approvals and enrollments send within seconds; the sweep is the backstop), and critical-class flows always bypass frequency caps and the window. To go slower per provider, set a `daily_limit` on the transport.

### Why did a contact get no email even though the flow ran?

Look at the message status on the contact or in Sent: `skipped` (the brain's decide step said wait/skip, or a step condition was false), `value_gated` (the assess step judged the draft not worth sending), `suppressed`, `rejected`, or `failed` (with the reason attached). All of these are terminal and deliberate; none of them retry on their own. Generation failures can be retried from the Approvals screen.

## Operations

### How do I back this up?

One Postgres database holds everything. `docker compose exec postgres pg_dump -U claros claros > backup.sql`, plus a copy of `ENCRYPTION_KEY` and `UNSUBSCRIBE_SIGNING_KEY`. Details in [INSTALLATION.md](./INSTALLATION.md#backups).

### What data leaves my server?

Only what you configure, to two kinds of destinations:

- **Your transport:** email content and recipient addresses go to Resend or your SMTP server when messages are sent
- **Your LLM provider (if configured):** prompts for compilation and drafting, which include your flow prompt, your `brain_context`, relevant contact context (traits, event history, lifecycle state), and any knowledge base entries you reference

There is no telemetry, analytics, or phone-home to Claros or anyone else. There is no inbound email processing. Webhooks only arrive if you register them yourself with Resend.

### Can I use Amazon SES?

Yes, through its SMTP endpoint: configure the `smtp` transport with the SES SMTP host and credentials. There is no SES API-mode integration, so no SES bounce/complaint webhooks. Details in [INSTALLATION.md](./INSTALLATION.md#email-transport).

### Can I run multiple workspaces on one instance?

Not through any UI or API today. The schema is multi-tenant and the engine is tenant-safe, but community creates exactly one workspace (`default`) at first boot. Multiple workspaces would require manual SQL and is unsupported.

### Can I use SQLite instead of Postgres?

No. Postgres is a hard requirement, not a preference. The reasons are structural:

- **pgvector**: knowledge base embeddings use `vector(1536)` columns with cosine-distance indexes
- **Table partitioning**: the events table is range-partitioned by month
- **pg-boss**: the job queue depends on Postgres schemas, `LISTEN/NOTIFY`, and advisory locks
- **Advisory locks**: ingest deduplication serializes concurrent writes per contact

There is no SQLite adapter and building one is not planned.

### What does each secret do and what happens if it changes?

**`ENCRYPTION_KEY`** (base64, 32 bytes): encrypts transport and LLM credentials at rest in the database. If you change it, existing stored credentials become undecryptable - re-enter them via Settings or `claros transport set` / `claros llm set`. The server starts without it but cannot store or read credentials.

**`UNSUBSCRIBE_SIGNING_KEY`** (hex, 32 bytes): signs the one-click unsubscribe token in every outgoing email's List-Unsubscribe header. This key is **permanent** - changing it breaks every unsubscribe link in already-delivered email, which is a compliance failure (CAN-SPAM, GDPR). Generate once, back up, never rotate.

If multiple instances disagree on either key, failures are silent and intermittent. See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full breakdown.

### How do I move the database out of compose?

1. Stop the stack: `docker compose down` (do NOT pass `-v`)
2. Dump: `docker compose exec postgres pg_dump -U claros claros > backup.sql`
3. Load into your external Postgres: `psql -h <host> -U <user> -d <db> < backup.sql`
4. Update `DATABASE_URL` in `.env` to point at the external host
5. Remove or comment out the `postgres` service in docker-compose.yml
6. `docker compose up -d`

The app tests the connection at startup and logs clearly if it fails.

### How do I change the port?

Set `PORT` in `.env` (compose maps `${PORT:-3000}:3000`) and restart. If the app is behind a proxy, set `BASE_URL` to the public URL so unsubscribe and login links are correct.

### How do I update to a new release?

`git pull && docker compose up -d --build`. Migrations run on boot in the compose stack. Back up first, and read the release notes. Details in [INSTALLATION.md](./INSTALLATION.md#upgrading).

### Where are the logs?

`docker compose logs -f app`. Set `LOG_LEVEL=debug` in `.env` for more. The drain, compiler, and content workers all log to the same stream.

### Something is still wrong

Run `docker compose exec app claros doctor` and include its output (it never prints secrets) in a [GitHub issue](https://github.com/claroshq/claros/issues).
