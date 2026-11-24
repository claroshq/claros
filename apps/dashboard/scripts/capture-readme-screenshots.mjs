#!/usr/bin/env node
/**
 * Capture README and guide screenshots from the seeded local dashboard.
 *
 * Prerequisites:
 *   1. Local Postgres running with seeded data (node scripts/seed-screenshots.mjs)
 *   2. API server running on :3000 (npm run dev or docker compose up)
 *   3. Dashboard dev server running on :5173 (npm run dev)
 *
 * Usage:
 *   node scripts/capture-readme-screenshots.mjs [--base http://localhost:5173]
 *
 * Outputs PNG files to oss/guide/assets/ (overwriting existing ones).
 * Also saves the full set to scripts/.screenshots-out/ for review.
 *
 * Theme decision: Dark theme for the README. Reasons:
 *   - Developer tools are overwhelmingly viewed in dark mode
 *   - Dark screenshots have better contrast on both GitHub light/dark backgrounds
 *   - The product's dark theme uses a neutral charcoal, not a harsh black
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", ".."); // apps/dashboard/scripts -> monorepo root
const GUIDE_ASSETS = join(ROOT, "oss", "guide", "assets");
const REVIEW_DIR = join(__dirname, ".screenshots-out");

mkdirSync(GUIDE_ASSETS, { recursive: true });
mkdirSync(REVIEW_DIR, { recursive: true });

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const DASHBOARD_BASE = argValue("--base") ?? "http://localhost:5173";
const API_BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// Get a fresh login link via the CLI
// ---------------------------------------------------------------------------
console.log("Generating login link...");
let verifyUrl;
try {
  const output = execSync(
    `node ${join(ROOT, "apps/server/bin/claros.mjs")} login-link hello@fundup.ai`,
    { encoding: "utf8", cwd: ROOT }
  );
  const match = output.match(/URL:\s+(http\S+)/);
  if (!match) throw new Error("Could not parse login link from CLI output");
  verifyUrl = match[1];
  console.log(`  Verify URL: ${verifyUrl}`);
} catch (err) {
  console.error("Failed to generate login link. Is the server running?");
  console.error(err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Screenshot helpers
// ---------------------------------------------------------------------------
const screenshots = [];

async function shoot(page, name, { clip } = {}) {
  await page.waitForTimeout(800); // let animations settle
  const opts = { path: join(REVIEW_DIR, `${name}.png`), fullPage: false };
  if (clip) opts.clip = clip;
  await page.screenshot(opts);
  screenshots.push({ name, path: opts.path });
  console.log(`  captured: ${name}.png`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const browser = await chromium.launch();

// Authenticate in a temporary context to get the session cookie
const tempCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
console.log("Authenticating...");
const token = new URL(verifyUrl).searchParams.get("token") ?? "";
const resp = await tempCtx.request.post(`${API_BASE}/auth/verify`, {
  form: { token },
  maxRedirects: 0,
});
const location = resp?.headers()["location"] ?? "";
if (location.includes("error=")) {
  console.error("Authentication failed (link may be expired/consumed).");
  console.error("Generate a fresh link: node apps/server/bin/claros.mjs login-link hello@fundup.ai");
  await browser.close();
  process.exit(1);
}
console.log(`  Auth OK (status=${resp.status()})`);
const sessionCookies = await tempCtx.cookies("http://localhost");
await tempCtx.close();

// Helper: create an authenticated context with a given color scheme
async function makeContext(scheme) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
    deviceScaleFactor: 2,
  });
  await ctx.addCookies(sessionCookies);
  return ctx;
}

// ---------------------------------------------------------------------------
// DARK MODE screens: Home, Analytics, Flows, Flow Editor, People, Sent Log
// ---------------------------------------------------------------------------
const darkCtx = await makeContext("dark");
const darkPage = await darkCtx.newPage();

console.log("\nCapturing Home (dark)...");
await darkPage.goto(`${DASHBOARD_BASE}/home`, { waitUntil: "networkidle" });
await shoot(darkPage, "home");

console.log("\nCapturing Analytics (dark)...");
await darkPage.goto(`${DASHBOARD_BASE}/analytics`, { waitUntil: "networkidle" });
await shoot(darkPage, "analytics");

console.log("\nCapturing Flows (dark)...");
await darkPage.goto(`${DASHBOARD_BASE}/flows`, { waitUntil: "networkidle" });
await shoot(darkPage, "flows");

// Flow editor with a compiled plan
const listResp = await darkCtx.request.get(`${API_BASE}/v1/flows`);
const listData = await listResp.json().catch(() => ({ flows: [] }));
const activeFlow = (listData.flows || []).find(
  (f) => f.status === "active" && f.compile_status === "ready" && f.prompt_source
);
if (activeFlow) {
  await darkPage.goto(`${DASHBOARD_BASE}/flows/${activeFlow.id}/edit`, { waitUntil: "networkidle" });
  await shoot(darkPage, "flow-editor");
}

console.log("\nCapturing People (dark)...");
await darkPage.goto(`${DASHBOARD_BASE}/people`, { waitUntil: "networkidle" });
await shoot(darkPage, "people");

console.log("\nCapturing Sent Log (dark)...");
await darkPage.goto(`${DASHBOARD_BASE}/sent`, { waitUntil: "networkidle" });
await shoot(darkPage, "sent-log");

await darkCtx.close();

// ---------------------------------------------------------------------------
// LIGHT MODE screens: Approvals, Lifecycle
// ---------------------------------------------------------------------------
const lightCtx = await makeContext("light");
const lightPage = await lightCtx.newPage();

console.log("\nCapturing Approvals (light)...");
await lightPage.goto(`${DASHBOARD_BASE}/approvals`, { waitUntil: "networkidle" });
await lightPage.waitForTimeout(600);
await shoot(lightPage, "approvals");

console.log("\nCapturing Lifecycle (light, with cell detail)...");
await lightPage.goto(`${DASHBOARD_BASE}/lifecycle`, { waitUntil: "networkidle" });
await lightPage.waitForTimeout(500);
// Click a populated cell to show the detail panel (Growing/Active has good numbers)
const growingActiveCell = lightPage.locator("button", { hasText: "17" }).first();
if (await growingActiveCell.count()) {
  await growingActiveCell.click();
  await lightPage.waitForTimeout(600);
}
await shoot(lightPage, "lifecycle");

await lightCtx.close();

// ---------------------------------------------------------------------------
// Copy final assets to oss/guide/assets/
// ---------------------------------------------------------------------------
console.log("\nCopying to oss/guide/assets/...");

// Map of screenshot name -> output filename in guide/assets
const GUIDE_MAP = {
  "home": "home.png",
  "approvals": "approvals.png",
  "flow-editor": "flow-editor.png",
  "lifecycle": "lifecycle.png",
};

for (const [name, destFilename] of Object.entries(GUIDE_MAP)) {
  const src = join(REVIEW_DIR, `${name}.png`);
  const dest = join(GUIDE_ASSETS, destFilename);
  copyFileSync(src, dest);
  console.log(`  ${destFilename}`);
}

await browser.close();

console.log("\n--- Done ---");
console.log(`Review all screenshots in: ${REVIEW_DIR}`);
console.log(`Guide assets updated in: ${GUIDE_ASSETS}`);
console.log("\nScreenshots captured:");
for (const s of screenshots) {
  console.log(`  ${s.name}.png`);
}
