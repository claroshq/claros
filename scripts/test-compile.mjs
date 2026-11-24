#!/usr/bin/env node
/**
 * Manual integration test for flow compilation against a real LLM endpoint.
 *
 * NEVER RUN IN CI. This script:
 *   1. Reads LLM credentials from .env (or environment)
 *   2. Compiles a sample flow prompt against the real endpoint
 *   3. Prints the result (compiled plan or error)
 *
 * Usage:
 *   node --env-file=.env scripts/test-compile.mjs
 *
 *   Or export variables directly:
 *     export LLM_API_KEY='sk-...'
 *     export LLM_BASE_URL='https://api.openai.com/v1'
 *     export LLM_MODEL='gpt-4o'
 *     node scripts/test-compile.mjs
 *
 * This script costs money (real API calls) and should only be run manually
 * to verify the integration works end-to-end.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { compile, OpenAICompatibleProvider } from "../packages/brain-oss/dist/index.js";

// ---------------------------------------------------------------------------
// Load .env from repo root (Node 21.7+ built-in)
// ---------------------------------------------------------------------------

const envPath = resolve(import.meta.dirname, "../.env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const apiKey = process.env.LLM_API_KEY ?? "";
const baseUrl = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
const model = process.env.LLM_MODEL ?? "gpt-4o";

if (!apiKey && !baseUrl.includes("localhost")) {
  console.error("ERROR: LLM_API_KEY is not set (required for non-local endpoints).");
  console.error("Set it in your shell:");
  console.error("  export LLM_API_KEY='sk-...'");
  process.exit(1);
}

console.log(`Provider: ${baseUrl}`);
console.log(`Model: ${model}`);
console.log(`API Key: ${apiKey ? apiKey.slice(0, 8) + "..." : "(empty - local endpoint)"}`);
console.log("");

// ---------------------------------------------------------------------------
// Sample prompt
// ---------------------------------------------------------------------------

const sampleCtx = {
  promptSource: `When a user moves from Engaged to At Risk, send them a personalized 
email highlighting features they haven't tried yet. Use @kb:feature-list 
for reference. Wait 3 days, then if they haven't returned, send a 
"we miss you" email using @template:win-back-gentle. If they return 
at any point, exit the flow.`,
  triggerType: "lifecycle_transition",
  triggerConfig: { from: "engaged", to: "at_risk" },
  availableTemplates: ["win-back-gentle", "welcome", "trial-ending"],
  availableKbEntries: ["feature-list", "pricing-faq"],
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log("Compiling flow...");
console.log(`Prompt: ${sampleCtx.promptSource.slice(0, 80)}...`);
console.log("");

const provider = new OpenAICompatibleProvider({ apiKey, baseUrl, model });
const startTime = Date.now();
const result = await compile(provider, sampleCtx);
const elapsed = Date.now() - startTime;

console.log(`Completed in ${elapsed}ms`);
console.log("");

if (result.ok) {
  console.log("SUCCESS - Compiled plan:");
  console.log(JSON.stringify(result.plan, null, 2));
  if (result.usage) {
    console.log("");
    console.log(`Tokens: ${result.usage.prompt_tokens} prompt + ${result.usage.completion_tokens} completion = ${result.usage.total_tokens} total`);
  }
} else {
  console.error("FAILED:");
  console.error(result.error);
  process.exit(1);
}
