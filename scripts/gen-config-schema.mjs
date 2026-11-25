#!/usr/bin/env node
// Generate docs/reference/claros.config.schema.json from the config Zod
// schema (packages/core/src/config/schema.ts). Needs the built core package
// (npm run build -w @claros/core).
//
//   node scripts/gen-config-schema.mjs           write the file
//   node scripts/gen-config-schema.mjs --check   exit 1 when the file is stale
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs/reference/claros.config.schema.json");
const core = join(root, "packages/core/dist/index.js");
if (!existsSync(core)) {
  console.error("gen-config-schema: packages/core is not built (npm run build -w @claros/core).");
  process.exit(2);
}
const { clarosConfigSchema, configJsonSchema } = await import(core);
const text = `${JSON.stringify(configJsonSchema(clarosConfigSchema), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (current !== text) {
    console.error("docs check: docs/reference/claros.config.schema.json is stale. Run: node scripts/gen-config-schema.mjs");
    process.exit(1);
  }
  process.exit(0);
}
writeFileSync(out, text);
console.log(`wrote ${out}`);
