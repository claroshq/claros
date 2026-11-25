/**
 * What the CLI deploys: the built Worker, the dashboard build and the SQLite
 * migrations.
 *
 * The published package carries them in assets/ (scripts/bundle-assets.mjs
 * copies them at pack time). Inside the repository the CLI uses the build
 * output in place (apps/worker/dist, apps/dashboard/dist,
 * drizzle/migrations-sqlite), so `npm run build` is enough to try it.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Assets {
  /** The bundled Worker entry (wrangler bundles it again on deploy). */
  workerMain: string;
  /** The dashboard build (Static Assets). */
  dashboardDir: string;
  /** SQLite / D1 migrations. */
  migrationsDir: string;
  /** Claros version these assets are. */
  version: string;
}

/** packages/cli (or the installed package root). */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function packageVersion(root = packageRoot()): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

export function resolveAssets(root = packageRoot()): Assets {
  const version = packageVersion(root);
  const packaged: Assets = {
    workerMain: join(root, "assets", "worker", "index.js"),
    dashboardDir: join(root, "assets", "dashboard"),
    migrationsDir: join(root, "assets", "migrations"),
    version,
  };
  if (existsSync(packaged.workerMain)) return packaged;

  const repo = resolve(root, "../..");
  const inRepo: Assets = {
    workerMain: join(repo, "apps", "worker", "dist", "index.js"),
    dashboardDir: join(repo, "apps", "dashboard", "dist"),
    migrationsDir: join(repo, "drizzle", "migrations-sqlite"),
    version,
  };
  for (const [what, path] of [
    ["Worker bundle", inRepo.workerMain],
    ["dashboard build", join(inRepo.dashboardDir, "index.html")],
    ["D1 migrations", inRepo.migrationsDir],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`The ${what} is missing (${path}). In the repository, run \`npm run build\` first.`);
    }
  }
  return inRepo;
}
