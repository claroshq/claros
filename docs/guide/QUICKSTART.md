# Quickstart

Three commands. One browser tab. A real email in your inbox.

**Time:** about 5 minutes with cached images, 10-15 minutes on a first pull.

**Prerequisites:** Docker with Compose V2 (`docker compose version` works). Nothing else.

---

## 1. Clone and install

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

## 2. Start

```bash
docker compose up
```

The claim URL is printed directly to the console. You will see a boxed URL like:

```
╔══════════════════════════════════════════════════════════════╗
║  CLAIM YOUR ACCOUNT                                         ║
║  ...                                                        ║
║  http://localhost:3000/claim?token=...                       ║
╚══════════════════════════════════════════════════════════════╝
```

## 3. Claim your account

Open that URL in a browser. Enter your email. You are now the owner, signed in, and looking at the dashboard Home page.

## 4. Finish setup (all in the browser)

Home shows a checklist. Complete it in any order:

1. **Transport** (Settings → Transport): connect Resend or SMTP so email can leave
2. **Postal address** (Settings → Postal): required by law in every email footer
3. **Active flow**: click "Install library flow" on the Home checklist, then activate it in Flows
4. **Send a test event**: go to Integrate, create a key, and use the "Send test event" panel

Within a minute of step 4, the welcome email arrives in your inbox. That is the full path.

---

## What just happened

Your test event created a contact, matched the welcome flow's trigger, generated a message from the pre-written template, and the drain worker sent it through your transport with one-click unsubscribe headers and your postal address in the footer.

## What you can skip

- **LLM provider**: not needed for the library flow or any fixed-content flow you write yourself. Add one later (Settings → LLM) for prompt-defined flows and AI-drafted copy.
- **`claros setup` wizard**: the CLI wizard still exists for headless or scripted installs. The browser path replaces it for interactive use.

## Where to go next

- [INSTALLATION.md](./INSTALLATION.md) - every setting, every environment variable, upgrading, backups
- [CONCEPTS.md](./CONCEPTS.md) - the mental model: events, contacts, compilation, approvals
- [DEPLOYMENT.md](./DEPLOYMENT.md) - external Postgres, multiple instances, the role split
- [INGESTION.md](./INGESTION.md) - wiring your application: browser snippet, server SDKs, Segment
- [FLOW-PROMPTS.md](./FLOW-PROMPTS.md) - working prompts for the flow editor
- [FAQ.md](./FAQ.md) - troubleshooting
