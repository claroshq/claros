#!/usr/bin/env node
/**
 * Generate the GitHub social preview image (1280x640, 2x = 2560x1280).
 *
 * Composites the Claros brand over a cropped section of the lifecycle grid
 * screenshot. The result is a dark card that shows the product is real.
 *
 * Usage:
 *   node scripts/generate-social-preview.mjs
 *
 * Outputs: oss/social-preview.png
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const OUTPUT = join(ROOT, "oss", "social-preview.png");

// The lifecycle screenshot to use as background
const LIFECYCLE_IMG = join(ROOT, "apps", "dashboard", "scripts", ".screenshots-out", "lifecycle.png");

let lifecycleBase64;
try {
  const buf = readFileSync(LIFECYCLE_IMG);
  lifecycleBase64 = `data:image/png;base64,${buf.toString("base64")}`;
} catch {
  console.error("Error: lifecycle screenshot not found. Run capture-readme-screenshots.mjs first.");
  process.exit(1);
}

const html = `<!DOCTYPE html>
<html>
<head>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Quicksand:wght@700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1280px;
    height: 640px;
    overflow: hidden;
    background: #1e2028;
    position: relative;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .screenshot {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-image: url('${lifecycleBase64}');
    background-size: cover;
    background-position: center top;
    opacity: 0.18;
    filter: blur(1px);
  }
  .overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: linear-gradient(135deg, rgba(20, 22, 30, 0.95) 0%, rgba(20, 22, 30, 0.7) 50%, rgba(20, 22, 30, 0.4) 100%);
  }
  .content {
    position: relative;
    z-index: 10;
    display: flex;
    flex-direction: column;
    justify-content: center;
    height: 100%;
    padding: 80px 100px;
  }
  .lockup {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 32px;
  }
  .mark {
    color: #4ac9ec;
    display: flex;
  }
  .wordmark {
    font-family: 'Quicksand', sans-serif;
    font-weight: 700;
    font-size: 52px;
    color: #e8eaed;
    letter-spacing: 0.03em;
  }
  .tagline {
    font-size: 28px;
    font-weight: 400;
    color: #b0b8c4;
    line-height: 1.4;
    max-width: 700px;
  }
  .tagline strong {
    color: #e8eaed;
    font-weight: 600;
  }
  .badges {
    display: flex;
    gap: 12px;
    margin-top: 36px;
  }
  .badge {
    background: rgba(74, 201, 236, 0.12);
    border: 1px solid rgba(74, 201, 236, 0.3);
    color: #4ac9ec;
    font-size: 14px;
    font-weight: 500;
    padding: 6px 14px;
    border-radius: 6px;
  }
  .product-shot {
    position: absolute;
    right: -40px;
    top: 60px;
    width: 680px;
    height: 520px;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 25px 50px rgba(0,0,0,0.4);
    opacity: 0.85;
  }
  .product-shot img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: left top;
  }
</style>
</head>
<body>
  <div class="screenshot"></div>
  <div class="overlay"></div>
  <div class="content">
    <div class="lockup">
      <span class="mark">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <g transform="translate(12 12) rotate(90)">
            <path d="M0 -10.8 C0 -10.8 -7.8 -2.5 -7.8 1.6 a7.8 7.8 0 0 0 15.6 0 C7.8 -2.5 0 -10.8 0 -10.8 Z M0 -2.4 a3.7 3.7 0 1 0 0.001 0 Z" fill="currentColor" fill-rule="evenodd"/>
          </g>
        </svg>
      </span>
      <span class="wordmark">claros</span>
    </div>
    <p class="tagline">
      The <strong>open-source lifecycle email engine.</strong><br>
      Prompt-defined flows, compiled once, executed deterministically.
    </p>
    <div class="badges">
      <span class="badge">Postgres only</span>
      <span class="badge">BYO LLM</span>
      <span class="badge">MIT License</span>
    </div>
  </div>
</body>
</html>`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 640 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(1000); // let font load
await page.screenshot({ path: OUTPUT, fullPage: false });
await browser.close();

console.log(`Social preview generated: ${OUTPUT}`);
console.log("Dimensions: 2560x1280 (1280x640 @2x)");
console.log("Upload to: GitHub repo Settings > Social preview");
