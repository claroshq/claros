// Copies what `claros deploy` ships into assets/ before `npm pack` / publish:
// the built Worker (apps/worker/dist), the dashboard build and the SQLite
// migrations. Run `npm run build` at the repository root first.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(pkg, "../..");
const out = join(pkg, "assets");

const sources = [
  [join(repo, "apps", "worker", "dist", "index.js"), join(out, "worker", "index.js")],
  [join(repo, "apps", "dashboard", "dist"), join(out, "dashboard")],
  [join(repo, "drizzle", "migrations-sqlite"), join(out, "migrations")],
];
for (const [from] of sources) {
  if (!existsSync(from)) {
    console.error(`missing ${from}: run \`npm run build\` at the repository root first`);
    process.exit(1);
  }
}

// The CLI deploys the version in its package.json; it must match the release.
const rootVersion = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const cliVersion = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
if (rootVersion !== cliVersion) {
  console.error(`packages/cli version ${cliVersion} differs from the release version ${rootVersion}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
for (const [from, to] of sources) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}
console.log(`assets/ ready for claros ${cliVersion}`);
