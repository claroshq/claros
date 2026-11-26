/**
 * What the CLI deploys: the built Worker, the dashboard build and the SQLite
 * migrations.
 *
 * The published package carries them in assets/ (scripts/bundle-assets.mjs
 * copies them at pack time and stamps assets/VERSION). Inside the repository
 * the CLI always uses the build output in place (apps/worker/dist,
 * apps/dashboard/dist, drizzle/migrations-sqlite), so `npm run build` is
 * enough, and an assets/ left over from an earlier pack is never deployed.
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

  // Inside the repository: always the build output in place. A leftover assets/
  // from an earlier `npm pack` must never be deployed instead of the current build.
  const repo = resolve(root, "../..");
  const inRepo: Assets = {
    workerMain: join(repo, "apps", "worker", "dist", "index.js"),
    dashboardDir: join(repo, "apps", "dashboard", "dist"),
    migrationsDir: join(repo, "drizzle", "migrations-sqlite"),
    version,
  };
  if (existsSync(join(repo, "apps", "worker", "package.json"))) {
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

  // The published package: assets/ from scripts/bundle-assets.mjs, stamped with the version they were built for.
  const packaged: Assets = {
    workerMain: join(root, "assets", "worker", "index.js"),
    dashboardDir: join(root, "assets", "dashboard"),
    migrationsDir: join(root, "assets", "migrations"),
    version,
  };
  if (!existsSync(packaged.workerMain)) {
    throw new Error(`The Worker bundle is missing (${packaged.workerMain}). Reinstall @claroshq/claros.`);
  }
  const stampFile = join(root, "assets", "VERSION");
  const stamp = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : null;
  if (stamp !== version) {
    throw new Error(
      `The bundled assets are for Claros ${stamp ?? "an unknown version"}, this package is ${version}. ` +
        "Reinstall @claroshq/claros (or rebuild it with `npm pack`).",
    );
  }
  return packaged;
}
