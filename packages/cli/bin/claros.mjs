#!/usr/bin/env node
// Entry point of the `claros` npm package (Claros on Cloudflare Workers + D1).
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
