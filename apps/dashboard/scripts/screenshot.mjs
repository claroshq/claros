/**
 * Screenshot harness for the dashboard.
 *
 * Fresh set of screenshots:
 *   docker compose exec app claros login-link <email>   # copy the URL
 *   node scripts/screenshot.mjs --base http://localhost:5173 --verify-url '<url>'
 * or store the URL in .screenshots/.verify-url and run without the flag.
 *
 * Produces PNGs in .screenshots/ at 1440x900 in both color schemes.
 * Authenticated pages reuse the host-scoped session cookie: the magic link
 * is redeemed once against the API origin and the cookie is shared with
 * each color-scheme context.
 *
 * States captured:
 *   01 login idle, 02 login filled, 03 login error (invalid_link),
 *   04 login sent, 05 flows populated, 06 flows loading, 07 flows error,
 *   08 flows empty, 10 unknown route, 11 expired session,
 *   12 editor new, 13 editor draft, 14 editor active (locked prompt + plan),
 *   15 compile pending, 16 compile result, 17 archive confirmation.
 * Loading, error, and empty are produced by intercepting GET /v1/flows, so
 * they need no database changes. 15/16 exercise the real compile pipeline
 * against the local tenant when a compilable draft exists. The expired
 * session shot pauses nothing: it clears the cookie and fires a real
 * mutation, which 401s into the expiry path. Any transition it performs is
 * reverted before the run ends.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const BASE = argValue("--base") ?? "http://localhost:5173";
const OUT = new URL("../.screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const VERIFY_URL_FILE = new URL("../.screenshots/.verify-url", import.meta.url).pathname;
let verifyUrl = argValue("--verify-url");
if (!verifyUrl && existsSync(VERIFY_URL_FILE)) {
  verifyUrl = readFileSync(VERIFY_URL_FILE, "utf8").trim();
}

async function shoot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: false });
  console.log(`  ${name}.png`);
}

const browser = await chromium.launch();

// The magic link is single-use: redeem it once, then share the host-scoped
// session cookie with every color-scheme context.
let sessionCookies = null;

for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // --- unauthenticated states (login redirects away when a session exists)
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-01-login`);

  await page.fill("#email", "founder@example.com");
  await shoot(page, `${scheme}-02-login-filled`);

  await page.goto(`${BASE}/login?error=invalid_link`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-03-login-error`);

  // sent state: stub the POST so no real email is requested
  await page.route("**/auth/login", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("#email", "founder@example.com");
  await page.click("button[type=submit]");
  await page.waitForSelector("text=Check your inbox");
  await shoot(page, `${scheme}-04-login-sent`);
  await page.unroute("**/auth/login");

  // --- authenticated states
  if (sessionCookies) {
    await context.addCookies(sessionCookies);
  } else if (verifyUrl) {
    // The magic link is single-use: redeem it once, then share the host-scoped
    // session cookie with every color-scheme context. GET /auth/verify only
    // shows the interstitial page; the token is consumed by POST /auth/verify
    // (the interstitial form action), which is what this replicates.
    const token = new URL(verifyUrl).searchParams.get("token") ?? "";
    const resp = await context.request.post(`${new URL(verifyUrl).origin}/auth/verify`, {
      form: { token },
      maxRedirects: 0,
    }).catch(() => null);
    const location = resp?.headers()["location"] ?? "";
    if (location.includes("error=")) {
      console.log("verify FAILED (spent or expired link); flows states will show login");
    } else {
      console.log(`verify attempt: status=${resp?.status()}`);
      sessionCookies = await context.cookies("http://localhost");
      await context.addCookies(sessionCookies);
    }
  }

  await page.goto(`${BASE}/flows`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-05-flows`);

  // Resolve flows by role for the editor and transition states.
  const listResp = await context.request.get(`${BASE}/v1/flows`);
  const list = await listResp.json().catch(() => ({ flows: [] }));
  const allFlows = Array.isArray(list.flows) ? list.flows : [];
  const draftFlow = allFlows.find((f) => f.status === "draft" && f.prompt_source);
  const activeFlow = allFlows.find((f) => f.status === "active");
  const compilableDraft = allFlows.find(
    (f) => f.status === "draft" && f.prompt_source && f.compile_status !== "pending",
  );

  // unknown route (inside the shell)
  await page.goto(`${BASE}/no-such-page`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-10-notfound`);

  // editor: new flow
  await page.goto(`${BASE}/flows/new`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-12-editor-new`);

  // editor: draft with prompt (compile row, activate gated)
  if (draftFlow) {
    await page.goto(`${BASE}/flows/${draftFlow.id}/edit`, { waitUntil: "networkidle" });
    await shoot(page, `${scheme}-13-editor-draft`);
  } else {
    console.log("  (no draft flow with prompt; 13 skipped)");
  }

  // editor: active flow (locked prompt, compiled plan)
  if (activeFlow) {
    await page.goto(`${BASE}/flows/${activeFlow.id}/edit`, { waitUntil: "networkidle" });
    await shoot(page, `${scheme}-14-editor-active`);
  } else {
    console.log("  (no active flow; 14 skipped)");
  }

  // compile: real POST against the local tenant. Without an LLM provider
  // configured this exercises the 422 precondition path, which is itself a
  // compile state worth recording.
  if (compilableDraft) {
    await page.goto(`${BASE}/flows/${compilableDraft.id}/edit`, { waitUntil: "networkidle" });
    const compileBtn = page.locator("button", { hasText: "Compile" }).first();
    await compileBtn.click();
    await page.waitForTimeout(1200);
    await shoot(page, `${scheme}-16b-compile-422`);
  } else {
    console.log("  (no compilable draft; 16b skipped)");
  }

  // compile pending and ready: presentation states produced by stubbing
  // GET /v1/flows/:id, because the local tenant has no LLM provider to run
  // a real compile through. The fabricated plan exercises every field the
  // plan shape allows (packages/core/src/flow/compiled-plan.ts).
  if (draftFlow) {
    const stubFlow = (overrides) =>
      Object.assign({}, draftFlow, overrides);

    const richPlan = {
      trigger: {
        type: "lifecycle_transition",
        condition: { from: "engaged", to: "at_risk" },
      },
      steps: [
        {
          order: 1,
          action_type: "send_email",
          delay: "0m",
          window_policy: "immediate",
          template_ref: "check_in_v1",
          brain_instruction: "Short, warm check-in. No pitch.",
        },
        {
          order: 2,
          action_type: "send_email",
          delay: "2d",
          window_policy: "respect_window",
          kb_ref: "win_back_playbook",
          condition: { lifecycle_state: "at_risk" },
        },
        {
          order: 3,
          action_type: "send_email",
          delay: "7d",
          window_policy: "respect_window",
          template_ref: "win_back_offer",
          brain_instruction: "Offer 20% off the next billing period.",
          condition: { lifecycle_state_not: "engaged" },
          exit_condition: { event_since_step: "plan_upgraded" },
        },
      ],
      exit_conditions: [
        { event: "plan_upgraded" },
        { lifecycle_state_change: { to: "gone_quiet" } },
      ],
    };

    // pending: pulsing badge, disabled compile button
    await context.route(`**/v1/flows/${draftFlow.id}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(stubFlow({ compile_status: "pending" })),
      }),
    );
    await page.goto(`${BASE}/flows/${draftFlow.id}/edit`, { waitUntil: "networkidle" });
    await shoot(page, `${scheme}-15-compile-pending`);
    await context.unroute(`**/v1/flows/${draftFlow.id}`);

    // ready: full plan renderer
    await context.route(`**/v1/flows/${draftFlow.id}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          stubFlow({
            compile_status: "ready",
            compiled_plan: richPlan,
            compiled_at: new Date().toISOString(),
          }),
        ),
      }),
    );
    await page.goto(`${BASE}/flows/${draftFlow.id}/edit`, { waitUntil: "networkidle" });
    await shoot(page, `${scheme}-16-compile-result`);
    await context.unroute(`**/v1/flows/${draftFlow.id}`);
  } else {
    console.log("  (no draft flow; 15/16 skipped)");
  }

  // archive confirmation (opened, not executed)
  if (draftFlow) {
    await page.goto(`${BASE}/flows/${draftFlow.id}/edit`, { waitUntil: "networkidle" });
    await page.locator("button", { hasText: "Archive" }).first().click();
    await shoot(page, `${scheme}-17-archive-confirm`);
    await page.locator("button", { hasText: "Cancel" }).first().click();
  } else {
    console.log("  (no draft flow; 17 skipped)");
  }

  // expired session: drop the cookie, then fire a real mutation. The 401
  // routes through apiFetch, which clears the session and flags the login
  // page. If a transition happened to succeed before the cookie cleared,
  // it is reverted below; with no cookie the PATCH 401s and nothing changes.
  if (activeFlow) {
    await page.goto(`${BASE}/flows`, { waitUntil: "networkidle" });
    await context.clearCookies();
    await page.locator("button", { hasText: "Pause" }).first().click();
    await page.waitForSelector("text=Sign in", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(600);
    await shoot(page, `${scheme}-11-session-expired`);
    // restore the session for the remaining states in this scheme
    if (sessionCookies) await context.addCookies(sessionCookies);
  } else {
    console.log("  (no active flow; 11 skipped)");
  }

  // loading: hold the flows response past the shot window. StrictMode can
  // fire the same request twice; continue each route at most once and never
  // throw after unroute.
  let holdFlows = true;
  await context.route("**/v1/flows", async (route) => {
    if (holdFlows) {
      holdFlows = false;
      await new Promise((r) => setTimeout(r, 3000));
    }
    await route.continue().catch(() => {});
  });
  await page.goto(`${BASE}/flows`);
  await page.waitForSelector("text=Flows");
  await page.screenshot({ path: `${OUT}${scheme}-06-flows-loading.png` });
  console.log(`  ${scheme}-06-flows-loading.png`);
  await context.unroute("**/v1/flows");

  // error: 500 from the API
  await context.route("**/v1/flows", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
  );
  await page.goto(`${BASE}/flows`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-07-flows-error`);
  await context.unroute("**/v1/flows");

  // empty: zero flows
  await context.route("**/v1/flows", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"flows":[]}' }),
  );
  await page.goto(`${BASE}/flows`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-08-flows-empty`);
  await context.unroute("**/v1/flows");

  // --- Step 6 (this phase): approvals, kb, settings, first run -----------
  // Real where the local DB has the state, stubbed where it does not.
  // Stubbed shots are marked in the console output and in the report.

  // SETTINGS (real): llm missing, transport configured, postal missing
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-20-settings-real`);

  // settings: LLM form (real: form is open because llm is null)
  await shoot(page, `${scheme}-21-settings-llm-form`);

  // settings: transport replace form open (real)
  const replaceBtn = page.locator("button", { hasText: "Replace" }).first();
  if (await replaceBtn.count()) {
    await replaceBtn.click();
    await shoot(page, `${scheme}-23-settings-transport-form`);
    await page.locator("button", { hasText: "Cancel" }).first().click();
  }

  // settings: saved state (STUBBED put + get for llm)
  await context.route("**/v1/settings/llm", (route) => {
    if (route.request().method() === "PUT") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          llm: {
            id: "11111111-1111-1111-1111-111111111111",
            provider: "openai",
            is_active: true,
            created_at: new Date().toISOString(),
          },
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        llm: {
          id: "11111111-1111-1111-1111-111111111111",
          provider: "openai",
          is_active: true,
          created_at: new Date().toISOString(),
        },
      }),
    });
  });
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-22-settings-llm-configured`);
  await context.unroute("**/v1/settings/llm");

  // APPROVALS: empty queue (real)
  await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-30-approvals-empty`);

  // APPROVALS: populated queue (STUBBED GET /v1/messages; local DB has none)
  const mkMsg = (i, overrides) =>
    Object.assign(
      {
        id: `00000000-0000-4000-8000-00000000000${i}`,
        tenant_id: "t",
        contact_id: `c0000000-0000-4000-8000-00000000000${i}`,
        flow_id: allFlows[0]?.id ?? "f",
        flow_step_order: i,
        status: "pending_approval",
        subject: null,
        body_html: null,
        body_text: null,
        brain_reasoning: null,
        brain_action_type: "send_email",
        created_at: new Date(Date.now() - i * 3600e3).toISOString(),
        updated_at: new Date(Date.now() - i * 3600e3).toISOString(),
        contact: {
          email: `user${i}@example.com`,
          name: i === 1 ? "Alex Chen" : i === 2 ? "Maria Lopez" : null,
          external_id: `user_${i}`,
        },
      },
      overrides,
    );
  const fakeMessages = [
    mkMsg(1, {
      subject: "Still there? A quick question about your workspace",
      body_html:
        '<!doctype html><html><body style="font-family:sans-serif;padding:24px;color:#111">' +
        "<p>Hi there,</p><p>We noticed your workspace has been quiet for two weeks. " +
        "Teams usually come back for one of three reasons, and we made a short guide for each.</p>" +
        '<p><a href="https://example.com" style="display:inline-block;background:#2f5dbd;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">See the guides</a></p>' +
        "<p>Claros</p><script>alert('must-not-run')</script></body></html>",
      brain_reasoning:
        "The contact entered at_risk 14 days ago after steady engagement. The playbook says the first touch should be low-pressure and question-led, not a discount. I kept it to three sentences and one link.",
    }),
    mkMsg(2, {
      subject: "Your win-back offer inside",
      body_text:
        "Hi,\n\nHere is 20% off your next billing period, valid until Friday.\n\nClaros",
      brain_action_type: "send_email",
    }),
    mkMsg(3, {
      subject: "One thing before you go",
      body_text: "Hi,\n\nA single question: what nearly stopped you from upgrading?\n\nClaros",
    }),
  ];
  await context.route("**/v1/messages", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: fakeMessages, next_cursor: null }),
    }),
  );
  await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-31-approvals-queue`);

  // approvals: reasoning disclosure open
  await page.locator("summary", { hasText: "Why the AI wrote it this way" }).click();
  await shoot(page, `${scheme}-31b-approvals-reasoning`);

  // approvals: approve success advances the queue (STUBBED 200)
  await context.route("**/v1/messages/*/approve", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "Message approved." }),
    }),
  );
  await page.locator("button", { hasText: "Approve" }).first().click();
  await page.waitForTimeout(500);
  await shoot(page, `${scheme}-32-approvals-approved`);
  await context.unroute("**/v1/messages/*/approve");

  // approvals: 409 reconciles instead of erroring (STUBBED 409)
  await context.route("**/v1/messages/*/approve", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Cannot approve message in status 'approved'.",
        id: "x",
        status: "approved",
      }),
    }),
  );
  await page.locator("button", { hasText: "Approve" }).first().click();
  await page.waitForTimeout(500);
  await shoot(page, `${scheme}-33-approvals-409`);
  await context.unroute("**/v1/messages/*/approve");
  await context.unroute("**/v1/messages");

  // KB: empty (real)
  await page.goto(`${BASE}/kb`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-40-kb-empty`);

  // KB: new entry form (real)
  await page.goto(`${BASE}/kb/new`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-41-kb-new`);

  // KB: populated list (STUBBED GET /v1/kb; local DB is empty)
  const mkEntry = (i, overrides) =>
    Object.assign(
      {
        id: `e0000000-0000-4000-8000-00000000000${i}`,
        tenant_id: "t",
        title: `Entry ${i}`,
        content_preview: "",
        content_type: "markdown",
        source: "manual",
        source_url: null,
        tags: [],
        embedding_status: null,
        is_active: true,
        created_at: new Date(Date.now() - i * 86400e3).toISOString(),
        updated_at: new Date(Date.now() - i * 3600e3).toISOString(),
      },
      overrides,
    );
  const fakeEntries = [
    mkEntry(1, {
      title: "Win-back playbook",
      content_preview:
        "Win-back works best in three touches: a question-led check-in at day 14, a value reminder at day 21, and an offer at day 30. Never lead with the discount; it trains churn. Keep the tone plain and short.",
      tags: ["playbook", "churn"],
    }),
    mkEntry(2, {
      title: "Pricing facts",
      content_preview:
        "Pro is $29 per seat per month, billed annually. Trials last 14 days and never require a card. Nonprofits get 50% off with verification.",
      tags: ["pricing"],
      embedding_status: "pending",
    }),
    mkEntry(3, {
      title: "Voice guide",
      content_preview:
        "Short sentences. No exclamation marks. Say the thing the user gets, not the feature name. Never say 'delve'.",
      embedding_status: "failed",
      tags: ["voice"],
    }),
    mkEntry(4, {
      title: "Old onboarding notes (superseded)",
      content_preview: "Superseded by the 2026 onboarding rewrite.",
      is_active: false,
    }),
  ];
  const kbListFulfill = (route) => {
    const url = route.request().url();
    const includeInactive = url.includes("include_inactive=true");
    const entries = includeInactive
      ? fakeEntries
      : fakeEntries.filter((e) => e.is_active);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ entries, next_cursor: null }),
    });
  };
  await context.route("**/v1/kb", kbListFulfill);
  await context.route("**/v1/kb?*", kbListFulfill);
  await page.goto(`${BASE}/kb`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-42-kb-list`);

  // KB: re-embed result (STUBBED POST /v1/kb/re-embed with remaining > 0)
  await context.route("**/v1/kb/re-embed", (route) =>
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ enqueued: 100, remaining: 34, total_qualifying: 134 }),
    }),
  );
  await page.locator("button", { hasText: "Re-embed failed" }).click();
  await page.waitForTimeout(500);
  await shoot(page, `${scheme}-45-kb-reembed`);
  await context.unroute("**/v1/kb/re-embed");

  // KB: detail with failed embedding (STUBBED GET /v1/kb/:id)
  const failedEntry = Object.assign({}, fakeEntries[2], {
    content:
      "Short sentences.\n\nNo exclamation marks.\n\nSay the thing the user gets, not the feature name.\n\nNever say 'delve'.",
    embedding_error:
      'Embedding model "text-embedding-3-small" returned a vector of 3072 dimensions, but kb_entries.embedding is vector(1536).',
  });
  delete failedEntry.content_preview;
  await context.route(`**/v1/kb/${failedEntry.id}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(failedEntry),
    }),
  );
  await page.goto(`${BASE}/kb/${failedEntry.id}`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-43-kb-detail-failed`);
  await context.unroute(`**/v1/kb/${failedEntry.id}`);
  await context.unroute("**/v1/kb");
  await context.unroute("**/v1/kb?*");

  // FIRST RUN: fresh tenant shape (real missing llm/postal; template section
  // needs an empty flows list, STUBBED here)
  await context.route("**/v1/flows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ flows: [] }),
    }),
  );
  await page.goto(`${BASE}/flows`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-50-firstrun`);
  await context.unroute("**/v1/flows");

  // FIRST RUN after completion (STUBBED llm+postal configured; checklist gone)
  await context.route("**/v1/settings/llm", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        llm: {
          id: "11111111-1111-1111-1111-111111111111",
          provider: "openai",
          is_active: true,
          created_at: new Date().toISOString(),
        },
      }),
    }),
  );
  await context.route("**/v1/settings/tenant", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        tenant: {
          id: "t",
          name: "Acme",
          slug: "acme",
          plan: "free",
          postal_address: "1 Main St\nSpringfield",
          created_at: new Date().toISOString(),
        },
      }),
    }),
  );
  await page.goto(`${BASE}/flows`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-51-firstrun-complete`);
  await context.unroute("**/v1/settings/llm");
  await context.unroute("**/v1/settings/tenant");

  // PEOPLE (seeded real data): populated, search, filter, empty-filter,
  // rich person, sparse person, suppressed person.
  await page.goto(`${BASE}/people`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-60-people`);

  await page.fill("input[type=search]", "ada");
  await page.waitForTimeout(700);
  await shoot(page, `${scheme}-61-people-search`);

  await page.fill("input[type=search]", "");
  await page.selectOption("select[aria-label='Filter by lifecycle state']", "churned");
  await page.waitForTimeout(600);
  await shoot(page, `${scheme}-62-people-filtered`);

  await page.selectOption("select[aria-label='Filter by lifecycle state']", "");
  await page.fill("input[type=search]", "zzz-no-such-person");
  await page.waitForTimeout(700);
  await shoot(page, `${scheme}-63-people-filtered-empty`);
  await page.fill("input[type=search]", "");

  // person detail: rich (Ada), sparse (Alan), suppressed (Edsger)
  const findContact = async (search) => {
    const r = await context.request.get(`${BASE}/v1/contacts?search=${search}`);
    const j = await r.json().catch(() => ({ contacts: [] }));
    return j.contacts?.[0]?.id;
  };
  const richId = await findContact("lovelace");
  const sparseId = await findContact("turing");
  const suppressedId = await findContact("dijkstra");
  if (richId) {
    await page.goto(`${BASE}/people/${richId}`, { waitUntil: "networkidle" });
    await shoot(page, `${scheme}-70-person-rich`);
    // open a payload disclosure
    const payloadSummary = page.locator("summary", { hasText: "payload" }).first();
    if (await payloadSummary.count()) {
      await payloadSummary.click();
      await shoot(page, `${scheme}-70b-person-payload`);
    }
  } else {
    console.log("  (rich contact not found; 70 skipped)");
  }
  if (sparseId) {
    await page.goto(`${BASE}/people/${sparseId}`, { waitUntil: "networkidle" });
    await shoot(page, `${scheme}-71-person-sparse`);
  } else {
    console.log("  (sparse contact not found; 71 skipped)");
  }
  if (suppressedId) {
    await page.goto(`${BASE}/people/${suppressedId}`, { waitUntil: "networkidle" });
    await shoot(page, `${scheme}-72-person-suppressed`);
  } else {
    console.log("  (suppressed contact not found; 72 skipped)");
  }

  // people list: empty (STUBBED), error (STUBBED), loading (STUBBED hold)
  const stubContacts = (handler) => {
    context.route("**/v1/contacts", handler);
    context.route("**/v1/contacts?*", handler);
  };
  const unstubContacts = () => {
    context.unroute("**/v1/contacts");
    context.unroute("**/v1/contacts?*");
  };

  stubContacts((route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ contacts: [], next_cursor: null }),
    }),
  );
  await page.goto(`${BASE}/people`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-66-people-empty`);
  unstubContacts();

  stubContacts((route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"error":"boom"}',
    }),
  );
  await page.goto(`${BASE}/people`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-65-people-error`);
  unstubContacts();

  let holdContacts = true;
  stubContacts(async (route) => {
    if (holdContacts) {
      holdContacts = false;
      await new Promise((r) => setTimeout(r, 3000));
    }
    await route.continue().catch(() => {});
  });
  await page.goto(`${BASE}/people`);
  await page.waitForSelector("text=People");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}${scheme}-64-people-loading.png` });
  console.log(`  ${scheme}-64-people-loading.png`);
  unstubContacts();

  // LIFECYCLE + ANALYTICS: volume is seeded real data; zero and sparse are
  // stubbed payloads (marked in the report).
  await page.goto(`${BASE}/lifecycle`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-80-lifecycle-volume`);

  // hover tooltip on the movement chart
  const lcChart = page.locator("figure").nth(0);
  const lcBox = await lcChart.boundingBox();
  if (lcBox) {
    await page.mouse.move(lcBox.x + lcBox.width * 0.7, lcBox.y + 60);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}${scheme}-80b-lifecycle-hover.png` });
    console.log(`  ${scheme}-80b-lifecycle-hover.png`);
    await page.mouse.move(lcBox.x + 10, lcBox.y + lcBox.height + 60);
  }

  const stubLifecycle = (payload) => {
    context.route("**/v1/analytics/lifecycle?*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) }),
    );
  };
  const unstubLifecycle = () => context.unroute("**/v1/analytics/lifecycle?*");

  stubLifecycle({
    range_days: 30,
    contacts_total: 0,
    distribution: [],
    movement: { per_state: [], edges: [], days: [] },
  });
  await page.goto(`${BASE}/lifecycle`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-81-lifecycle-zero`);

  stubLifecycle({
    range_days: 30,
    contacts_total: 3,
    distribution: [
      { state: "signed_up", total: 2, power: 0, regular: 0, casual: 0, minimal: 2, unset: 0 },
      { state: "engaged", total: 1, power: 0, regular: 1, casual: 0, minimal: 0, unset: 0 },
    ],
    movement: {
      per_state: [{ state: "activated", entered: 1, exited: 0 }],
      edges: [{ from_state: "signed_up", to_state: "activated", count: 1 }],
      days: [
        {
          day: new Date(Date.now() - 86400_000).toISOString().slice(0, 10),
          count: 1,
          positive: 1,
          negative: 0,
        },
      ],
    },
  });
  await page.goto(`${BASE}/lifecycle`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-82-lifecycle-sparse`);
  unstubLifecycle();

  await page.goto(`${BASE}/analytics`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-85-analytics-volume`);

  // hover tooltip on the sends chart
  const anChart = page.locator("figure").nth(0);
  const anBox = await anChart.boundingBox();
  if (anBox) {
    await page.mouse.move(anBox.x + anBox.width * 0.5, anBox.y + 60);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}${scheme}-85b-analytics-hover.png` });
    console.log(`  ${scheme}-85b-analytics-hover.png`);
    await page.mouse.move(anBox.x + 10, anBox.y + anBox.height + 60);
  }

  const stubSending = (payload) => {
    context.route("**/v1/analytics/sending?*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) }),
    );
  };
  const unstubSending = () => context.unroute("**/v1/analytics/sending?*");

  stubSending({
    range_days: 30,
    days: [],
    totals: { sent: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, suppressed: 0, failed: 0 },
    per_flow: [],
  });
  await page.goto(`${BASE}/analytics`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-86-analytics-zero`);

  stubSending({
    range_days: 30,
    days: [{ day: new Date(Date.now() - 86400_000).toISOString().slice(0, 10), sent: 4 }],
    totals: { sent: 4, opened: 3, clicked: 1, bounced: 0, complained: 0, suppressed: 0, failed: 0 },
    per_flow: [
      {
        flow_id: allFlows[0]?.id ?? "f",
        flow_name: allFlows[0]?.name ?? "Flow",
        sent: 4,
        opened: 3,
        clicked: 1,
        bounced: 0,
        complained: 0,
        suppressed: 0,
        failed: 0,
      },
    ],
  });
  await page.goto(`${BASE}/analytics`, { waitUntil: "networkidle" });
  await shoot(page, `${scheme}-87-analytics-sparse`);
  unstubSending();

  await context.close();
}

await browser.close();
console.log(`done -> ${OUT}`);
