/**
 * `claros`: deploy and operate Claros on Cloudflare Workers + D1.
 *
 *   claros deploy [--name <instance>] [--domain <host>] [--account <id>] [--non-interactive] [--dry-run] [--force]
 *   claros upgrade [--name <instance>]
 *   claros products set-host <slug> <host> [--name <instance>]
 *   claros doctor [--name <instance>]
 *   claros claim-url [--name <instance>]
 *   claros apply -f claros.config.json [--dry-run] [--url <url>] [--key <admin key>] [--name <instance>]
 *   claros kb import <file.jsonl> [--dry-run] [--force] [--url <url>] [--key <admin key>] [--name <instance>]
 *   claros import messages <file.jsonl> [--dry-run] [--url <url>] [--key <admin key>] [--name <instance>]
 *   claros import events <file.jsonl> [--dry-run] [--url <url>] [--key <admin key>] [--name <instance>]
 *   claros import lifecycle [--dry-run] [--forecast-days <n>] [--url <url>] [--key <admin key>] [--name <instance>]
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { resolveAssets, packageVersion, type Assets } from "./assets.js";
import { claimUrlCommand, defaultContextParts, deploy, doctor, setProductHost, upgrade, type Context, type Io } from "./ops.js";
import { defaultConfigDir } from "./state.js";
import { spawnRunner, Wrangler, type Runner } from "./wrangler.js";
import { applyConfig } from "./apply.js";
import { kbImport, importEvents, importLifecycle, importMessages } from "./import.js";

export const USAGE = `Usage: claros <command> [options]
       npx @claroshq/claros <command> [options]   (without a global install)

Deploy and operate Claros on Cloudflare Workers + D1 (uses wrangler and your Cloudflare login).

Commands:
  deploy                       Create or update an instance (idempotent)
  upgrade                      Back up D1, migrate and deploy this package's version
  products set-host <slug> <host>
                               Serve a product's links on its own host (custom domain)
  doctor                       Check secrets, migrations, routes, /health and /version
  claim-url                    Mint a new first-account claim link (no user yet)
  apply -f <file>              Apply a product config document (PUT /v1/config);
                               --dry-run lists the changes. URL: --url, CLAROS_URL or
                               the instance --name; key: --key or CLAROS_ADMIN_KEY
  kb import <file>             Import knowledge base entries (JSONL or a JSON array)
                               by external_key (POST /v1/kb/import); --dry-run,
                               --force overwrites entries edited since their import
  import messages <file>       Import sent-message history (JSONL; POST
                               /v1/import/messages); --dry-run
  import events <file>         Import historical events with their timestamps
                               (JSONL; POST /v1/import/events); --dry-run
  import lifecycle             Recompute lifecycle states from the event history
                               (POST /v1/import/lifecycle); --dry-run reports the
                               counts, --forecast-days <n> (default 14)

Options:
  --name <instance>            Instance name (default "default"); resources are claros-<name>
  --domain <host>              deploy: custom domain for the instance (default: workers.dev)
  --account <id>               Cloudflare account id or name
  --non-interactive            Never prompt (CI)
  --dry-run                    deploy, apply: list the changes without making them;
                               kb import, import: validate and count, write nothing
  --force                      deploy: deploy the Worker even when nothing changed;
                               kb import: overwrite entries edited since their import
  -h, --help                   This help
  -v, --version                The Claros version this package deploys

State: ~/.config/claros/<name>.json (mode 600) and ~/.config/claros/<name>/.
`;

export interface MainDeps {
  runner?: Runner;
  io?: Io;
  fetch?: Context["fetch"];
  configDir?: string;
  assets?: () => Assets;
}

function terminalIo(interactive: boolean): Io {
  return {
    log: (line = "") => console.log(line),
    warn: (line) => console.error(`warning: ${line}`),
    prompt: interactive
      ? async (question) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await rl.question(question);
          } finally {
            rl.close();
          }
        }
      : undefined,
  };
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        name: { type: "string" },
        domain: { type: "string" },
        account: { type: "string" },
        "non-interactive": { type: "boolean" },
        "forecast-days": { type: "string" },
        "dry-run": { type: "boolean" },
        force: { type: "boolean" },
        file: { type: "string", short: "f" },
        url: { type: "string" },
        key: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    console.log(packageVersion());
    return 0;
  }
  const [command, sub, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 2;
  }

  const nonInteractive = Boolean(values["non-interactive"]) || !process.stdin.isTTY;
  let assets: Assets | null = null;
  const ctx: Context = {
    wrangler: new Wrangler(deps.runner ?? spawnRunner()),
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    io: deps.io ?? terminalIo(!nonInteractive),
    configDir: deps.configDir ?? defaultConfigDir(),
    assets: deps.assets ?? (() => (assets ??= resolveAssets())),
    ...defaultContextParts(),
  };
  const common = { name: values.name, account: values.account, nonInteractive };

  switch (command) {
    case "deploy":
      await deploy(ctx, { ...common, domain: values.domain, dryRun: values["dry-run"], force: values.force });
      return 0;
    case "upgrade":
      await upgrade(ctx, common);
      return 0;
    case "products":
      if (sub !== "set-host" || rest.length !== 2) {
        console.error("Usage: claros products set-host <slug> <host> [--name <instance>]");
        return 2;
      }
      await setProductHost(ctx, { ...common, slug: rest[0]!, host: rest[1]! });
      return 0;
    case "doctor": {
      const checks = await doctor(ctx, common);
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    case "claim-url":
      await claimUrlCommand(ctx, common);
      return 0;
    case "kb":
      if (sub !== "import") {
        console.error(`Unknown command "kb ${sub ?? ""}".\n\n${USAGE}`);
        return 2;
      }
      return kbImport(ctx, { file: rest[0] ?? values.file, dryRun: values["dry-run"], force: values.force, url: values.url, key: values.key, name: values.name });
    case "import":
      if (sub === "messages") {
        return importMessages(ctx, { file: rest[0] ?? values.file, dryRun: values["dry-run"], url: values.url, key: values.key, name: values.name });
      }
      if (sub === "events") {
        return importEvents(ctx, { file: rest[0] ?? values.file, dryRun: values["dry-run"], url: values.url, key: values.key, name: values.name });
      }
      if (sub === "lifecycle") {
        return importLifecycle(ctx, { dryRun: values["dry-run"], forecastDays: values["forecast-days"], url: values.url, key: values.key, name: values.name });
      }
      console.error(`Unknown command "import ${sub ?? ""}".\n\n${USAGE}`);
      return 2;
    case "apply":
      return applyConfig(ctx, { file: values.file, dryRun: values["dry-run"], url: values.url, key: values.key, name: values.name });
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}
