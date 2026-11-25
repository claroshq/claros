# Quickstart

From nothing to a tracked event and a real email in your inbox. Claros runs on two runtimes with the same HTTP API, engine and dashboard; pick one and follow its column, then continue at [Claim your account](#2-claim-your-account).

| | Docker + Postgres | Cloudflare Workers + D1 |
|---|---|---|
| You need | Docker with Compose V2 (`docker compose version` works) | A Cloudflare account and Node.js 22+ (for `npx`) |
| Install | `git clone https://github.com/claroshq/claros.git && cd claros`<br>`docker compose run --rm install`<br>`docker compose up` | `npx @claroshq/claros deploy --domain claros.example.com` |
| Data | Postgres 16 with pgvector (bundled, or your own) | One D1 database in your account |
| Time | about 5 minutes with cached images, 10-15 minutes on a first pull | a few minutes; a new custom domain can take a few more for its certificate |

Not sure which? [Choose a runtime](./INSTALLATION.md#choose-a-runtime) compares them. Both are supported; Postgres is not going anywhere.

---

## 1a. Docker + Postgres

```bash
git clone https://github.com/claroshq/claros.git && cd claros
docker compose run --rm install
```

The install command:
- Creates `.env` from the example with generated secrets (`ENCRYPTION_KEY`, `UNSUBSCRIBE_SIGNING_KEY`)
- Reads the project directory owner and sets `.env` ownership to match so you can edit it
- Chooses the bundled Postgres and says so, with the flag to point at your own instead
- Applies schema migrations

It prints the generated secrets. Copy them to your password manager now; they are required to decrypt stored credentials and validate unsubscribe links in delivered email.

**Using an external Postgres instead of the bundled one?** Pass it directly:

```bash
docker compose run --rm install \
  --database-url 'postgres://user:pass@your-host:5432/claros'
```

The command tests the connection, reports a clear error if it fails, and writes the URL to `.env`. For a full walkthrough of external Postgres and multi-instance deployments, see [DEPLOYMENT.md](./DEPLOYMENT.md).

Then start it:

```bash
docker compose up
```

The claim URL is printed directly to the console in a box headed `CLAIM YOUR ACCOUNT`, like `http://localhost:3000/claim?token=...`. Your instance is at `http://localhost:3000`.

## 1b. Cloudflare Workers + D1

The CLI is the npm package `@claroshq/claros`; `npx` runs it without installing. It drives wrangler with your Cloudflare login, so sign in first:

```bash
npx wrangler login
npx @claroshq/claros deploy --domain claros.example.com
```

`--domain` attaches a custom domain to the Worker. Leave it out to serve the instance on `claros-default.<your-subdomain>.workers.dev`. The command never changes DNS records: if the host already has a DNS record or belongs to another Worker, it stops and names the host.

`deploy` creates the D1 database, the job queues, the secrets (`ENCRYPTION_KEY`, `UNSUBSCRIBE_SIGNING_KEY`) and the Worker, applies migrations, waits until the new version answers, and prints a one-time claim URL (valid for 24 hours). Generated secrets are also written to `~/.config/claros/default.json`: back that file up.

Running the command again is safe; it changes only what is missing. Lost the claim URL? `npx @claroshq/claros claim-url` prints a new one while no user exists. Every option and step is in [Install on Cloudflare Workers + D1](../install/cloudflare.md).

## 2. Claim your account

Open the claim URL in a browser. Enter your email. You are now the owner and the instance admin, signed in, and looking at the dashboard Home page.

## 3. Finish setup (all in the browser)

Home shows a checklist. Complete it in any order:

1. **Transport** (Settings, Transport): connect Resend or SMTP so email can leave. Cloudflare Email Service is available too, for transactional mail only; see [TRANSPORTS.md](./TRANSPORTS.md).
2. **Postal address** (Settings, Postal): required by law in every email footer
3. **Active flow**: click "Install library flow" on the Home checklist, then activate it in Flows
4. **Send a test event**: go to Integrate, create a key, and use the "Send test event" panel

## 4. Track your first event

The Integrate panel sends a real event through the public API. To send one from your terminal instead, create a secret key (`clr_sk_...`) on the Integrate page and post to your instance:

```bash
curl -X POST https://claros.example.com/v1/identify \
  -H "Authorization: Bearer clr_sk_YOUR_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "traits": {"email": "you@example.com"}}'

curl -X POST https://claros.example.com/v1/track \
  -H "Authorization: Bearer clr_sk_YOUR_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "event": "signed_up"}'
```

Use `http://localhost:3000` as the host on a local Docker install. Integrate shows "Latest event received" once the event lands; shortly after, the welcome email arrives in your inbox. That is the full path.

## 5. Add a second product

One instance can run several products, each with its own contacts, flows, topics, transports, brand, keys and team. As the instance admin, open Settings, Products, enter a name and a slug, and create it. Switch to it from the product switcher at the top of the sidebar, then repeat step 3 for it: every product brings its own transport, postal address and flows. With two or more active products, the dashboard opens on a product picker. See [PRODUCTS.md](./PRODUCTS.md).

---

## What just happened

Your test event created a contact, matched the welcome flow's trigger, generated a message from the pre-written template, and the drain sent it through your transport with one-click unsubscribe headers and your postal address in the footer. On Docker the job chain runs on pg-boss inside Postgres; on Workers it runs on Cloudflare Queues. The steps are the same.

## What you can skip

- **LLM provider**: not needed for the library flow or any fixed-content flow you write yourself. Add one later (Settings, LLM) for prompt-defined flows and AI-drafted copy.
- **`claros setup` wizard** (Docker image): the CLI wizard still exists for headless or scripted installs. The browser path replaces it for interactive use.

## Where to go next

- [INSTALLATION.md](./INSTALLATION.md) - choosing a runtime, every setting, every environment variable, upgrading, backups
- [Install on Cloudflare Workers + D1](../install/cloudflare.md) - bindings, `claros upgrade`, product hosts, `wrangler dev`
- [PRODUCTS.md](./PRODUCTS.md) - several products on one instance, roles, archiving
- [CONCEPTS.md](./CONCEPTS.md) - the mental model: products, events, contacts, compilation, approvals
- [DEPLOYMENT.md](./DEPLOYMENT.md) - external Postgres, multiple instances, the role split
- [INGESTION.md](./INGESTION.md) - wiring your application: browser snippet, server SDKs, Segment
- [FLOW-PROMPTS.md](./FLOW-PROMPTS.md) - working prompts for the flow editor
- [FAQ.md](./FAQ.md) - troubleshooting
