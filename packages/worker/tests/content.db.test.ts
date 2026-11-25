/**
 * Integration tests for the content generation worker (task 17.5).
 *
 * Tests the full Brain pipeline: decide -> draft -> render -> write.
 * LLM calls are mocked (no network). Postgres is real.
 *
 * Tests:
 * - Full path: pending_generation -> generating -> awaiting_content -> pending_approval
 *   with subject, body_html, and body_text populated.
 * - Skip/wait decisions land at 'skipped' with reasoning recorded.
 * - Permanent faults (provider resolution failure, 4xx LLM rejections) fail
 *   the message terminally with the reason in brain_reasoning.
 * - Transient LLM errors leave the row at 'generating' (reap recovers).
 * - CAS rejects a stale write.
 * - Markdown renders to both HTML and text.
 * - Tenant with no active LLM config fails permanently like any resolution fault.
 * - Two concurrent ticks claim disjoint sets (SKIP LOCKED holds).
 * - Reap still recovers stuck 'generating' messages.
 * - Tenant scoping is respected.
 *
 * Requires local Postgres (docker compose up postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import {
  tenants,
  contacts,
  flows,
  flowMemberships,
  lifecycleMessages,
} from "@claros/db/schema";

// ---------------------------------------------------------------------------
// Mocks: brain-oss decide and draft, and provider-resolver
// ---------------------------------------------------------------------------

const mockDecide = vi.fn();
const mockDraft = vi.fn();
const mockAssess = vi.fn();
const mockResolveTenantProvider = vi.fn();

vi.mock("@claros/brain-oss", async () => {
  // Import the real module to get the prompt builders and other pure functions.
  // Only the three LLM call functions (decide, draft, assess) are mocked.
  const real = await vi.importActual<typeof import("@claros/brain-oss")>("@claros/brain-oss");
  return {
    ...real,
    decide: (...args: unknown[]) => mockDecide(...args),
    draft: (...args: unknown[]) => mockDraft(...args),
    assess: (...args: unknown[]) => mockAssess(...args),
  };
});

vi.mock("../src/provider-resolver.js", () => ({
  resolveTenantProvider: (...args: unknown[]) => mockResolveTenantProvider(...args),
  overLlmBudget: async () => false,
}));

// Import AFTER mocks are set up
const { processContentTick, claimContentBatch, renderMarkdownToHtml, markdownToText } = await import("../src/content.js");
const { processReapTick } = await import("../src/reap.js");

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.DATABASE_URL;
if (!TEST_DB_URL) {
  const inCI = process.env.CI === "true";
  throw new Error(
    `[content.test] DATABASE_URL is not set.\n\n` +
      `This test requires a Postgres connection.\n` +
      (inCI
        ? `Set the variable in the workflow env block:\n\n  DATABASE_URL: postgres://claros:claros@localhost:5432/claros\n`
        : `Set the variable in .env (see .env.example) or export it:\n\n  export DATABASE_URL='postgres://claros:claros@localhost:5433/claros'\n`),
  );
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let dbAvailable = false;
let testTenantId: string;
let otherTenantId: string;

const SLUG = "test-content-worker";
const SLUG_OTHER = "test-content-worker-other";

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool);
    dbAvailable = true;
  } catch (err) {
    const inCI = process.env.CI === "true";
    if (inCI) {
      throw new Error(
        `[content.test] DATABASE_URL not reachable in CI.\n` +
          `URL: ${TEST_DB_URL}\nCause: ${(err as Error).message}`,
      );
    }
    console.warn("[content.test] DATABASE_URL not reachable - tests skipped.");
    return;
  }

  await cleanup();

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Test Content Worker", slug: SLUG, plan: "free" })
    .returning({ id: tenants.id });
  testTenantId = tenant!.id;

  const [other] = await db
    .insert(tenants)
    .values({ name: "Test Content Worker Other", slug: SLUG_OTHER, plan: "free" })
    .returning({ id: tenants.id });
  otherTenantId = other!.id;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  // Reset mocks
  mockDecide.mockReset();
  mockDraft.mockReset();
  mockAssess.mockReset();
  mockResolveTenantProvider.mockReset();

  // Default mock behavior: provider resolves, decide returns "contact", draft returns content,
  // assess returns "pass" (gate passes by default; override in gate-specific tests)
  mockResolveTenantProvider.mockResolvedValue({
    ok: true,
    provider: { complete: vi.fn() }, // provider object (not called directly by worker)
  });
  mockDecide.mockResolvedValue({
    ok: true,
    decision: { action: "contact", reasoning: "test: contact is engaged and ready" },
  });
  mockDraft.mockResolvedValue({
    ok: true,
    draft: { subject: "Test Subject", body_markdown: "Hello **world**" },
  });
  mockAssess.mockResolvedValue({
    ok: true,
    assessment: { verdict: "pass", reasoning: "Email is personalized and relevant." },
  });

  // Clean messages for both tenants
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM lifecycle_messages WHERE tenant_id = ${otherTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flow_memberships WHERE tenant_id = ${otherTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${testTenantId}`);
  await db.execute(sql`DELETE FROM flows WHERE tenant_id = ${otherTenantId}`);
  await db.execute(
      sql`DELETE FROM lifecycle_transitions WHERE tenant_id = ${testTenantId}`,
    );
    await db.execute(
      sql`DELETE FROM contacts WHERE tenant_id = ${testTenantId}`,
    );
  await db.execute(
      sql`DELETE FROM lifecycle_transitions WHERE tenant_id = ${otherTenantId}`,
    );
    await db.execute(
      sql`DELETE FROM contacts WHERE tenant_id = ${otherTenantId}`,
    );
});

afterAll(async () => {
  if (dbAvailable) {
    await cleanup();
  }
  await pool.end();
});

async function cleanup() {
  for (const slug of [SLUG, SLUG_OTHER]) {
    await db.execute(
      sql`DELETE FROM lifecycle_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM flow_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM flows WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM lifecycle_transitions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM contacts WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(
      sql`DELETE FROM scan_checkpoints WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = ${slug})`,
    );
    await db.execute(sql`DELETE FROM tenants WHERE slug = ${slug}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertContact(
  externalId: string,
  tenantId: string = testTenantId,
): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      tenantId,
      externalId,
      email: `${externalId}@example.com`,
      lifecycleState: "engaged",
      firstSeenAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-20T00:00:00Z"),
    })
    .returning({ id: contacts.id });
  return row!.id;
}

async function insertFlow(
  name: string,
  tenantId: string = testTenantId,
): Promise<string> {
  const [row] = await db
    .insert(flows)
    .values({
      tenantId,
      name,
      priority: 0,
      triggerType: "lifecycle_transition",
      triggerConfig: { from: "engaged", to: "at_risk" },
      steps: [{ order: 1, action_type: "nurture_value", delay: "0d" }],
      status: "paused",
      flowClass: "nurture",
      compiledPlan: {
        trigger: { type: "lifecycle_transition", condition: { from: "engaged", to: "at_risk" } },
        steps: [{ order: 1, action_type: "nurture_value", delay: "0d" }],
      },
    })
    .returning({ id: flows.id });
  return row!.id;
}

async function insertMembership(
  contactId: string,
  flowId: string,
  tenantId: string = testTenantId,
): Promise<string> {
  const [row] = await db
    .insert(flowMemberships)
    .values({
      tenantId,
      contactId,
      flowId,
      currentStep: 1,
      status: "completed",
      enteredAt: new Date("2026-07-20T00:00:00Z"),
      completedAt: new Date("2026-07-20T00:00:00Z"),
      exitReason: "completed",
    })
    .returning({ id: flowMemberships.id });
  return row!.id;
}

async function insertPendingGenerationMessage(opts: {
  contactId: string;
  flowId: string;
  membershipId: string;
  tenantId?: string;
  createdAt?: Date;
  brainActionType?: string;
}): Promise<string> {
  const tenantId = opts.tenantId ?? testTenantId;
  const [row] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId,
      contactId: opts.contactId,
      flowId: opts.flowId,
      membershipId: opts.membershipId,
      flowStepOrder: 1,
      status: "pending_generation",
      brainActionType: opts.brainActionType ?? "nurture_value",
    })
    .returning({ id: lifecycleMessages.id });

  // If custom createdAt, backdate it
  if (opts.createdAt) {
    await db.execute(sql`
      UPDATE lifecycle_messages
      SET created_at = ${opts.createdAt}, updated_at = ${opts.createdAt}
      WHERE id = ${row!.id}
    `);
  }

  return row!.id;
}

async function getMessage(id: string) {
  const [row] = await db
    .select({
      status: lifecycleMessages.status,
      retryCount: lifecycleMessages.retryCount,
      updatedAt: lifecycleMessages.updatedAt,
      brainReasoning: lifecycleMessages.brainReasoning,
      brainActionType: lifecycleMessages.brainActionType,
      subject: lifecycleMessages.subject,
      bodyHtml: lifecycleMessages.bodyHtml,
      bodyText: lifecycleMessages.bodyText,
    })
    .from(lifecycleMessages)
    .where(eq(lifecycleMessages.id, id));
  return row!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("content generation worker", () => {
  it("skips when DATABASE_URL is not reachable", () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Full path: pending_generation -> generating -> awaiting_content -> pending_approval
  // -------------------------------------------------------------------------

  describe("full path: decide contact -> draft -> pending_approval", () => {
    it("advances through generating -> awaiting_content -> pending_approval with content", async () => {
      if (!dbAvailable) return;

      mockDraft.mockResolvedValue({
        ok: true,
        draft: {
          subject: "Welcome to Acme",
          body_markdown: "# Hello\n\nWelcome to **Acme Corp**.\n\n[Get started](https://acme.com/start)",
        },
      });

      const contactId = await insertContact("content-full-path");
      const flowId = await insertFlow("content-full-path-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({
        contactId,
        flowId,
        membershipId,
      });

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await processContentTick(db, now, 20, [testTenantId]);

      expect(result.claimed).toBe(1);
      expect(result.advanced).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("pending_approval");
      expect(msg.subject).toBe("Welcome to Acme");
      // bodyHtml is email-safe inline-styled HTML; check structural content not exact tag form
      expect(msg.bodyHtml).toMatch(/<h[1-3][^>]*>/);
      expect(msg.bodyHtml).toContain("<strong>Acme Corp</strong>");
      expect(msg.bodyHtml).toContain('href="https://acme.com/start"');
      expect(msg.bodyText).toContain("Hello");
      expect(msg.bodyText).toContain("Acme Corp");
      expect(msg.bodyText).toContain("https://acme.com/start");
      expect(msg.brainReasoning).toBe("test: contact is engaged and ready");
      expect(msg.updatedAt!.getTime()).toBe(now.getTime());
    });
  });

  // -------------------------------------------------------------------------
  // Skip and wait decisions
  // -------------------------------------------------------------------------

  describe("skip and wait decisions", () => {
    it("marks message as skipped when decide returns skip", async () => {
      if (!dbAvailable) return;

      mockDecide.mockResolvedValue({
        ok: true,
        decision: { action: "skip", reasoning: "contact just received an email yesterday" },
      });

      const contactId = await insertContact("content-skip");
      const flowId = await insertFlow("content-skip-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({
        contactId,
        flowId,
        membershipId,
      });

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await processContentTick(db, now, 20, [testTenantId]);

      expect(result.claimed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.advanced).toBe(0);
      expect(result.errors).toBe(0);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("skipped");
      expect(msg.brainReasoning).toBe("skip: contact just received an email yesterday");
    });

    it("marks message as skipped when decide returns wait (treated as skip)", async () => {
      if (!dbAvailable) return;

      mockDecide.mockResolvedValue({
        ok: true,
        decision: { action: "wait", reasoning: "not the right moment, check again later" },
      });

      const contactId = await insertContact("content-wait");
      const flowId = await insertFlow("content-wait-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({
        contactId,
        flowId,
        membershipId,
      });

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await processContentTick(db, now, 20, [testTenantId]);

      expect(result.claimed).toBe(1);
      expect(result.skipped).toBe(1);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("skipped");
      expect(msg.brainReasoning).toBe("wait: not the right moment, check again later");
    });

    it("records action type without reasoning when reasoning is absent", async () => {
      if (!dbAvailable) return;

      mockDecide.mockResolvedValue({
        ok: true,
        decision: { action: "skip" },
      });

      const contactId = await insertContact("content-skip-no-reason");
      const flowId = await insertFlow("content-skip-no-reason-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({
        contactId,
        flowId,
        membershipId,
      });

      const now = new Date("2026-07-21T10:00:00Z");
      await processContentTick(db, now, 20, [testTenantId]);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("skipped");
      expect(msg.brainReasoning).toBe("skip");
    });
  });

  // -------------------------------------------------------------------------
  // Provider faults: permanent -> terminal failed; transient -> stays for reap
  // -------------------------------------------------------------------------

  describe("provider error handling", () => {
    it("fails the message permanently when provider resolution fails", async () => {
      if (!dbAvailable) return;

      mockResolveTenantProvider.mockResolvedValue({
        ok: false,
        reason: "No LLM configuration found.",
      });

      const contactId = await insertContact("content-provider-error");
      const flowId = await insertFlow("content-provider-error-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({
        contactId,
        flowId,
        membershipId,
      });

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await processContentTick(db, now, 20, [testTenantId]);

      expect(result.claimed).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.advanced).toBe(0);
      expect(result.skipped).toBe(0);

      // Resolution failure is a configuration fault: terminal, with the
      // reason recorded where the dashboard surfaces it.
      const msg = await getMessage(messageId);
      expect(msg.status).toBe("failed");
      expect(msg.brainReasoning).toBe("generation_failed: No LLM configuration found.");
    });

    it("leaves message at generating when decide() returns an LLM error", async () => {
      if (!dbAvailable) return;

      mockDecide.mockResolvedValue({
        ok: false,
        error: "LLM call failed: 500 Internal Server Error",
      });

      const contactId = await insertContact("content-decide-error");
      const flowId = await insertFlow("content-decide-error-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({
        contactId,
        flowId,
        membershipId,
      });

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await processContentTick(db, now, 20, [testTenantId]);

      expect(result.errors).toBe(1);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("generating");
    });

    it("tenant with no active LLM config fails the message permanently", async () => {
      if (!dbAvailable) return;

      mockResolveTenantProvider.mockResolvedValue({
        ok: false,
        reason: "No LLM configuration found. Add an LLM provider in Settings.",
      });

      const contactId = await insertContact("content-no-llm");
      const flowId = await insertFlow("content-no-llm-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({
        contactId,
        flowId,
        membershipId,
      });

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await processContentTick(db, now, 20, [testTenantId]);

      expect(result.failed).toBe(1);
      expect(result.errors).toBe(0);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("failed");
      expect(msg.brainReasoning).toBe(
        "generation_failed: No LLM configuration found. Add an LLM provider in Settings.",
      );
    });

    it("leaves message at awaiting_content when draft() fails (reap recovery path)", async () => {
      if (!dbAvailable) return;

      mockDraft.mockResolvedValue({
        ok: false,
        error: "LLM returned invalid JSON: <html>",
      });

      const contactId = await insertContact("content-draft-error");
      const flowId = await insertFlow("content-draft-error-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({
        contactId,
        flowId,
        membershipId,
      });

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await processContentTick(db, now, 20, [testTenantId]);

      expect(result.errors).toBe(1);

      // Message moved to awaiting_content by decide(), left there by draft() error
      const msg = await getMessage(messageId);
      expect(msg.status).toBe("awaiting_content");
    });
  });

  // -------------------------------------------------------------------------
  // CAS prevents stale write
  // -------------------------------------------------------------------------

  describe("CAS prevents stale write", () => {
    it("CAS write hits 0 rows when message is no longer at generating", async () => {
      if (!dbAvailable) return;

      // This test exercises the CAS mechanism directly (no mocks needed).
      const contactId = await insertContact("content-cas");
      const flowId = await insertFlow("content-cas-flow");
      const membershipId = await insertMembership(contactId, flowId);

      const [row] = await db
        .insert(lifecycleMessages)
        .values({
          tenantId: testTenantId,
          contactId,
          flowId,
          membershipId,
          flowStepOrder: 1,
          status: "generating",
        })
        .returning({ id: lifecycleMessages.id });
      const messageId = row!.id;

      // Simulate reap resetting it back to pending_generation
      await db.execute(sql`
        UPDATE lifecycle_messages
        SET status = 'pending_generation', updated_at = NOW()
        WHERE id = ${messageId}
      `);

      // Now simulate a stale content worker trying to advance with CAS
      const casResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'pending_approval', updated_at = NOW()
        WHERE id = ${messageId}
          AND status = 'generating'
        RETURNING id
      `);

      // CAS should fail - message is no longer 'generating'
      expect(casResult.rows).toHaveLength(0);

      // Message should still be at pending_generation
      const msg = await getMessage(messageId);
      expect(msg.status).toBe("pending_generation");
    });

    it("CAS rejects stale write on awaiting_content -> pending_approval", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("content-cas-await");
      const flowId = await insertFlow("content-cas-await-flow");
      const membershipId = await insertMembership(contactId, flowId);

      const [row] = await db
        .insert(lifecycleMessages)
        .values({
          tenantId: testTenantId,
          contactId,
          flowId,
          membershipId,
          flowStepOrder: 1,
          status: "awaiting_content",
        })
        .returning({ id: lifecycleMessages.id });
      const messageId = row!.id;

      // Simulate something moving it away from awaiting_content
      await db.execute(sql`
        UPDATE lifecycle_messages
        SET status = 'pending_generation', updated_at = NOW()
        WHERE id = ${messageId}
      `);

      // CAS on awaiting_content should fail
      const casResult = await db.execute<{ id: string }>(sql`
        UPDATE lifecycle_messages
        SET status = 'pending_approval', subject = 'test', updated_at = NOW()
        WHERE id = ${messageId}
          AND status = 'awaiting_content'
        RETURNING id
      `);

      expect(casResult.rows).toHaveLength(0);
      const msg = await getMessage(messageId);
      expect(msg.status).toBe("pending_generation");
    });
  });

  // -------------------------------------------------------------------------
  // Markdown rendering
  // -------------------------------------------------------------------------

  describe("markdown renders to both html and text", () => {
    it("renders markdown with headings, bold, links to proper html", () => {
      const md = "# Welcome\n\nHello **world**.\n\n[Click here](https://example.com)";
      const html = renderMarkdownToHtml(md);
      // Headings carry inline styles now; check tag opens without asserting full attribute list
      expect(html).toMatch(/<h1[^>]*>Welcome<\/h1>/);
      expect(html).toContain("<strong>world</strong>");
      // Links carry inline styles; assert the href is present
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain(">Click here<");
    });


  });

  // -------------------------------------------------------------------------
  // HTML sanitization: model-emitted dangerous content is neutralised
  // -------------------------------------------------------------------------

  describe("renderMarkdownToHtml sanitizes model-emitted dangerous content", () => {
    it("escapes block script tags so they are not live HTML", () => {
      const md = "<script>alert(1)</script>\n\nHello";
      const html = renderMarkdownToHtml(md);
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("</script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("Hello");
    });

    it("escapes block img with onerror attribute", () => {
      const md = '<img src="x" onerror="alert(1)">';
      const html = renderMarkdownToHtml(md);
      // Must not be a live tag
      expect(html).not.toMatch(/<img[^>]+onerror/i);
      expect(html).toContain("&lt;img");
    });

    it("escapes inline img with onerror inside a paragraph", () => {
      // Inline HTML token (block: false) inside a paragraph - must invoke html() override
      const md = 'Hello <img src="x" onerror="alert(1)"> world.';
      const html = renderMarkdownToHtml(md);
      expect(html).not.toMatch(/<img[^>]+onerror/i);
      expect(html).toContain("&lt;img");
      expect(html).toContain("Hello");
      expect(html).toContain("world");
    });

    it("escapes inline HTML with event handler inside a list item", () => {
      const md = '- Item with <b onclick="alert(1)">click</b> here';
      const html = renderMarkdownToHtml(md);
      // No live <b onclick=...> tag
      expect(html).not.toMatch(/<b[^>]+onclick/i);
      expect(html).toContain("&lt;b onclick=");
      expect(html).toContain("click");
    });

    it("escapes inline img inside link text", () => {
      const md = '[link <img src=x onerror=alert(1)>](https://example.com)';
      const html = renderMarkdownToHtml(md);
      expect(html).not.toMatch(/<img[^>]+onerror/i);
      expect(html).toContain("&lt;img");
      // The link href itself is safe and should render
      expect(html).toContain('href="https://example.com"');
    });

    it("escapes iframe tags", () => {
      const md = '<iframe src="https://evil.com"></iframe>';
      const html = renderMarkdownToHtml(md);
      expect(html).not.toContain("<iframe");
      expect(html).toContain("&lt;iframe");
    });

    it("replaces javascript: href with # in markdown links", () => {
      const md = "[click](javascript:alert(1))";
      const html = renderMarkdownToHtml(md);
      expect(html).not.toContain("javascript:");
      expect(html).toContain('href="#"');
      expect(html).toContain(">click<");
    });

    it("replaces data: href with # in markdown links", () => {
      const md = "[click](data:text/html,<h1>x</h1>)";
      const html = renderMarkdownToHtml(md);
      expect(html).not.toContain("data:");
      expect(html).toContain('href="#"');
    });

    it("renders normal https links without modification", () => {
      const md = "[safe](https://example.com)";
      const html = renderMarkdownToHtml(md);
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain(">safe<");
    });

    it("renders markdown formatting correctly after sanitization", () => {
      const md = "# Hello\n\n**bold** and _italic_\n\n- item 1\n- item 2";
      const html = renderMarkdownToHtml(md);
      // Headings carry inline styles; check tag opens
      expect(html).toMatch(/<h1[^>]*>/);
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<em>italic</em>");
      // List items carry inline styles
      expect(html).toMatch(/<li[^>]*>item 1<\/li>/);
      expect(html).toMatch(/<li[^>]*>item 2<\/li>/);
    });
  });

  // -------------------------------------------------------------------------
  // markdownToText: derive plain text from markdown source
  // -------------------------------------------------------------------------

  describe("markdownToText derives plain text from markdown source", () => {
    it("preserves link targets as (url) suffixes", () => {
      const md = "Visit [our site](https://example.com/start) today.";
      const text = markdownToText(md);
      expect(text).toContain("our site (https://example.com/start)");
      expect(text).not.toContain("<");
      expect(text).not.toContain(">");
    });

    it("formats unordered list items with dash prefix", () => {
      const md = "- Item 1\n- Item 2\n- Item 3";
      const text = markdownToText(md);
      expect(text).toContain("- Item 1");
      expect(text).toContain("- Item 2");
      expect(text).toContain("- Item 3");
    });

    it("formats ordered list items with number prefix", () => {
      const md = "1. First\n2. Second\n3. Third";
      const text = markdownToText(md);
      expect(text).toContain("1. First");
      expect(text).toContain("2. Second");
      expect(text).toContain("3. Third");
    });

    it("includes heading text without markup characters", () => {
      const md = "# Big Heading\n\nSome content.";
      const text = markdownToText(md);
      expect(text).toContain("Big Heading");
      expect(text).not.toContain("#");
    });

    it("strips raw HTML blocks from plain text output", () => {
      const md = "<script>alert(1)</script>\n\nSafe text.";
      const text = markdownToText(md);
      expect(text).not.toContain("<script>");
      expect(text).not.toContain("alert(1)");
      expect(text).toContain("Safe text.");
    });

    it("decodes HTML entities in text content", () => {
      const md = "A & B and some text.";
      const text = markdownToText(md);
      expect(text).toContain("A & B");
    });

    it("preserves blockquote structure", () => {
      const md = "> This is a quote.";
      const text = markdownToText(md);
      expect(text).toContain("> This is a quote.");
    });
  });

  // -------------------------------------------------------------------------
  // Claim and SKIP LOCKED
  // -------------------------------------------------------------------------

  describe("message already at generating is not re-claimed", () => {
    it("does not claim messages that are already at generating status", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("content-no-reclaim");
      const flowId = await insertFlow("content-no-reclaim-flow");
      const membershipId = await insertMembership(contactId, flowId);

      // Insert directly at 'generating' (as if another worker claimed it)
      await db.insert(lifecycleMessages).values({
        tenantId: testTenantId,
        contactId,
        flowId,
        membershipId,
        flowStepOrder: 1,
        status: "generating",
      });

      const now = new Date("2026-07-21T10:00:00Z");
      const claimed = await claimContentBatch(db, now, 10, [testTenantId]);

      expect(claimed).toHaveLength(0);
    });
  });

  describe("concurrent ticks claim disjoint sets (SKIP LOCKED)", () => {
    it("two concurrent ticks get completely disjoint messages", async () => {
      if (!dbAvailable) return;

      // Create 4 messages
      const messages: string[] = [];
      for (let i = 0; i < 4; i++) {
        const contactId = await insertContact(`content-concurrent-${i}`);
        const flowId = await insertFlow(`content-concurrent-flow-${i}`);
        const membershipId = await insertMembership(contactId, flowId);
        const msgId = await insertPendingGenerationMessage({
          contactId,
          flowId,
          membershipId,
        });
        messages.push(msgId);
      }

      const now = new Date("2026-07-21T10:00:00Z");

      // Run two content ticks concurrently, each with batchLimit=2
      const [result1, result2] = await Promise.all([
        processContentTick(db, now, 2, [testTenantId]),
        processContentTick(db, now, 2, [testTenantId]),
      ]);

      // Total claimed should be 4 (each gets 2 disjoint messages)
      const totalClaimed = result1.claimed + result2.claimed;
      expect(totalClaimed).toBe(4);

      // All should have advanced (mocked Brain always succeeds by default)
      const totalAdvanced = result1.advanced + result2.advanced;
      expect(totalAdvanced).toBe(4);

      // Verify all messages are now 'pending_approval' in DB
      for (const msgId of messages) {
        const msg = await getMessage(msgId);
        expect(msg.status).toBe("pending_approval");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Reap recovery
  // -------------------------------------------------------------------------

  describe("reap recovery of stuck generating message", () => {
    it("reap resets a stuck generating message to pending_generation", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T12:00:00Z");
      const stuckAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      const contactId = await insertContact("content-reap");
      const flowId = await insertFlow("content-reap-flow");
      const membershipId = await insertMembership(contactId, flowId);

      const [row] = await db
        .insert(lifecycleMessages)
        .values({
          tenantId: testTenantId,
          contactId,
          flowId,
          membershipId,
          flowStepOrder: 1,
          status: "generating",
          retryCount: 0,
        })
        .returning({ id: lifecycleMessages.id });
      const messageId = row!.id;

      await db.execute(sql`
        UPDATE lifecycle_messages
        SET updated_at = ${stuckAt}
        WHERE id = ${messageId}
      `);

      await processReapTick(db, now, [testTenantId]);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("pending_generation");
      expect(msg.retryCount).toBe(1);
      expect(msg.updatedAt!.getTime()).toBe(now.getTime());
    });

    it("reap marks as failed after MAX_RETRY_COUNT", async () => {
      if (!dbAvailable) return;

      const now = new Date("2026-07-21T12:00:00Z");
      const stuckAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

      const contactId = await insertContact("content-reap-fail");
      const flowId = await insertFlow("content-reap-fail-flow");
      const membershipId = await insertMembership(contactId, flowId);

      const [row] = await db
        .insert(lifecycleMessages)
        .values({
          tenantId: testTenantId,
          contactId,
          flowId,
          membershipId,
          flowStepOrder: 1,
          status: "generating",
          retryCount: 3,
        })
        .returning({ id: lifecycleMessages.id });
      const messageId = row!.id;

      await db.execute(sql`
        UPDATE lifecycle_messages
        SET updated_at = ${stuckAt}
        WHERE id = ${messageId}
      `);

      await processReapTick(db, now, [testTenantId]);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("failed");
    });
  });

  // -------------------------------------------------------------------------
  // Tenant scoping
  // -------------------------------------------------------------------------

  describe("tenant scoping", () => {
    it("only claims messages for the specified tenant, not other tenants", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("content-scope-main");
      const flowId = await insertFlow("content-scope-main-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const mainMsgId = await insertPendingGenerationMessage({
        contactId,
        flowId,
        membershipId,
      });

      const otherContactId = await insertContact("content-scope-other", otherTenantId);
      const otherFlowId = await insertFlow("content-scope-other-flow", otherTenantId);
      const otherMembershipId = await insertMembership(otherContactId, otherFlowId, otherTenantId);
      const otherMsgId = await insertPendingGenerationMessage({
        contactId: otherContactId,
        flowId: otherFlowId,
        membershipId: otherMembershipId,
        tenantId: otherTenantId,
      });

      const now = new Date("2026-07-21T10:00:00Z");
      const claimed = await claimContentBatch(db, now, 10, [testTenantId]);

      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.id).toBe(mainMsgId);
      expect(claimed[0]!.tenantId).toBe(testTenantId);

      const otherMsg = await getMessage(otherMsgId);
      expect(otherMsg.status).toBe("pending_generation");

      const mainMsg = await getMessage(mainMsgId);
      expect(mainMsg.status).toBe("generating");
    });

    it("processContentTick discovers and claims from all tenants with pending messages", async () => {
      if (!dbAvailable) return;

      const contactId = await insertContact("content-multi-tenant-a");
      const flowId = await insertFlow("content-multi-tenant-a-flow");
      const membershipId = await insertMembership(contactId, flowId);
      const msgA = await insertPendingGenerationMessage({
        contactId,
        flowId,
        membershipId,
      });

      const otherContactId = await insertContact("content-multi-tenant-b", otherTenantId);
      const otherFlowId = await insertFlow("content-multi-tenant-b-flow", otherTenantId);
      const otherMembershipId = await insertMembership(otherContactId, otherFlowId, otherTenantId);
      const msgB = await insertPendingGenerationMessage({
        contactId: otherContactId,
        flowId: otherFlowId,
        membershipId: otherMembershipId,
        tenantId: otherTenantId,
      });

      const now = new Date("2026-07-21T10:00:00Z");
      const result = await processContentTick(db, now, 20, [testTenantId, otherTenantId]);

      expect(result.claimed).toBe(2);
      expect(result.advanced).toBe(2);

      const msgAState = await getMessage(msgA);
      expect(msgAState.status).toBe("pending_approval");
      const msgBState = await getMessage(msgB);
      expect(msgBState.status).toBe("pending_approval");
    });
  });

  describe("value gate (task 20)", () => {
    it("passing verdict: message reaches pending_approval with content intact", async () => {
      if (!dbAvailable) return;
      const contactId = await insertContact("vg-pass");
      const flowId = await insertFlow("VG Pass Flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({ contactId, flowId, membershipId });

      // mockAssess is already set to pass in beforeEach
      const now = new Date("2026-07-26T10:00:00Z");
      const result = await processContentTick(db, now, 1, [testTenantId]);

      expect(result.advanced).toBe(1);
      expect(result.valueGated).toBe(0);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("pending_approval");
      expect(msg.subject).toBe("Test Subject");
      expect(msg.bodyHtml).toBeTruthy();
      expect(msg.bodyText).toBeTruthy();
    });

    it("rejection verdict: message lands at value_gated with draft content and reasoning persisted", async () => {
      if (!dbAvailable) return;
      const contactId = await insertContact("vg-fail");
      const flowId = await insertFlow("VG Fail Flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({ contactId, flowId, membershipId });

      mockAssess.mockResolvedValueOnce({
        ok: true,
        assessment: {
          verdict: "fail",
          reasoning: "The email is generic and does not reference any of the contact's specific usage data.",
        },
      });

      const now = new Date("2026-07-26T10:00:00Z");
      const result = await processContentTick(db, now, 1, [testTenantId]);

      expect(result.advanced).toBe(0);
      expect(result.valueGated).toBe(1);

      const msg = await getMessage(messageId);
      // Terminal status
      expect(msg.status).toBe("value_gated");
      // Draft content preserved for audit
      expect(msg.subject).toBe("Test Subject");
      expect(msg.bodyHtml).toBeTruthy();
      expect(msg.bodyText).toBeTruthy();
      // Gate reasoning recorded
      expect(msg.brainReasoning).toContain("value_gated");
      expect(msg.brainReasoning).toContain("generic");
    });

    it("gate call error leaves message at awaiting_content for reap (never marks value_gated)", async () => {
      if (!dbAvailable) return;
      const contactId = await insertContact("vg-error");
      const flowId = await insertFlow("VG Error Flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({ contactId, flowId, membershipId });

      // Simulate a gate call error (LLM failure)
      mockAssess.mockResolvedValueOnce({
        ok: false,
        error: "LLM call failed: rate limited",
      });

      const now = new Date("2026-07-26T10:00:00Z");
      const result = await processContentTick(db, now, 1, [testTenantId]);

      expect(result.advanced).toBe(0);
      expect(result.valueGated).toBe(0);
      expect(result.errors).toBe(1);

      const msg = await getMessage(messageId);
      // Must NOT be value_gated - must be at awaiting_content for reap
      expect(msg.status).not.toBe("value_gated");
      expect(msg.status).toBe("awaiting_content");
    });

    it("three-path budget: assess call is checked after draft and does not prevent pending_approval when within budget", async () => {
      if (!dbAvailable) return;
      const contactId = await insertContact("vg-budget");
      const flowId = await insertFlow("VG Budget Flow");
      const membershipId = await insertMembership(contactId, flowId);
      const messageId = await insertPendingGenerationMessage({ contactId, flowId, membershipId });

      // Default mocks: assess passes
      const now = new Date("2026-07-26T10:00:00Z");
      const result = await processContentTick(db, now, 1, [testTenantId]);

      expect(result.advanced).toBe(1);

      const msg = await getMessage(messageId);
      expect(msg.status).toBe("pending_approval");
      // assess() was called exactly once
      expect(mockAssess).toHaveBeenCalledOnce();
    });
  });
});
