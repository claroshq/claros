/** Which build `claros deploy` / `upgrade` ships: never a leftover assets/ in the repository, never mismatched assets. */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAssets } from "../src/assets.js";

function file(path: string, text = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function cliPackage(root: string, version: string, stamp: string | null): void {
  file(join(root, "package.json"), JSON.stringify({ name: "@claroshq/claros", version }));
  file(join(root, "assets", "worker", "index.js"));
  file(join(root, "assets", "dashboard", "index.html"));
  mkdirSync(join(root, "assets", "migrations"), { recursive: true });
  if (stamp !== null) file(join(root, "assets", "VERSION"), `${stamp}\n`);
}

describe("resolveAssets", () => {
  it("in the repository uses the current build, even with an assets/ left from an earlier pack", () => {
    const repo = mkdtempSync(join(tmpdir(), "claros-repo-"));
    const root = join(repo, "packages", "cli");
    cliPackage(root, "0.8.12", "0.8.10");
    file(join(repo, "apps", "worker", "package.json"), "{}");
    file(join(repo, "apps", "worker", "dist", "index.js"));
    file(join(repo, "apps", "dashboard", "dist", "index.html"));
    mkdirSync(join(repo, "drizzle", "migrations-sqlite"), { recursive: true });
    expect(resolveAssets(root)).toEqual({
      workerMain: join(repo, "apps", "worker", "dist", "index.js"),
      dashboardDir: join(repo, "apps", "dashboard", "dist"),
      migrationsDir: join(repo, "drizzle", "migrations-sqlite"),
      version: "0.8.12",
    });
  });

  it("in the repository without a build says to run npm run build", () => {
    const repo = mkdtempSync(join(tmpdir(), "claros-repo-"));
    const root = join(repo, "packages", "cli");
    cliPackage(root, "0.8.12", "0.8.12");
    file(join(repo, "apps", "worker", "package.json"), "{}");
    expect(() => resolveAssets(root)).toThrow(/npm run build/);
  });

  it("an installed package uses its assets when the stamp is its version", () => {
    const root = join(mkdtempSync(join(tmpdir(), "claros-npm-")), "node_modules", "@claroshq", "claros");
    cliPackage(root, "0.8.12", "0.8.12");
    expect(resolveAssets(root).workerMain).toBe(join(root, "assets", "worker", "index.js"));
  });

  it("refuses assets built for another version, or without a stamp", () => {
    const a = join(mkdtempSync(join(tmpdir(), "claros-npm-")), "node_modules", "@claroshq", "claros");
    cliPackage(a, "0.8.12", "0.8.10");
    expect(() => resolveAssets(a)).toThrow(/assets are for Claros 0\.8\.10, this package is 0\.8\.12/);
    const b = join(mkdtempSync(join(tmpdir(), "claros-npm-")), "node_modules", "@claroshq", "claros");
    cliPackage(b, "0.8.12", null);
    expect(() => resolveAssets(b)).toThrow(/unknown version/);
  });
});
