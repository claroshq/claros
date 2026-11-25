# @claroshq/claros

Install and upgrade [Claros](https://github.com/claroshq/claros), the open-source lifecycle email engine, in your own Cloudflare account.

```bash
npx @claroshq/claros deploy --domain claros.example.com
```

The command creates (or finds) a D1 database, two Queues and the Worker, applies the database migrations, sets the two required secrets, deploys, and prints a one-time claim URL for the first account. Running it again changes nothing that already exists.

Other commands: `upgrade`, `products set-host <slug> <host>`, `doctor`, `claim-url`, `apply`, `kb import` and `import messages`. Run `npx @claroshq/claros --help` for options.

`npm i -g @claroshq/claros` installs the CLI globally as the `claros` command (`claros deploy`, `claros upgrade`, ...).

Requires Node.js 22+ and a Cloudflare account. Claros also runs on Postgres with Docker; see the [installation docs](https://github.com/claroshq/claros/tree/main/docs).

MIT licensed.
