import { describe, it, expect } from "vitest";
import { draft, DRAFT_TEMPERATURE } from "../src/draft.js";
import type { LlmProvider, CompletionOptions, CompletionResult } from "../src/providers/types.js";
import { buildDraftMessages, type DraftPromptContext } from "../src/prompts/draft.js";

// ---------------------------------------------------------------------------
// Mock provider factory
// ---------------------------------------------------------------------------

function mockProvider(
  response: string,
  usage?: CompletionResult["usage"],
): LlmProvider & { lastOpts?: CompletionOptions } {
  const provider: LlmProvider & { lastOpts?: CompletionOptions } = {
    lastOpts: undefined,
    async complete(opts: CompletionOptions): Promise<CompletionResult> {
      provider.lastOpts = opts;
      return { content: response, usage };
    },
  };
  return provider;
}

function failingProvider(error: Error): LlmProvider {
  return {
    async complete(): Promise<CompletionResult> {
      throw error;
    },
  };
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

const baseCtx: DraftPromptContext = {
  brain_instruction: "Write a re-engagement email highlighting the dashboard feature they haven't used.",
  action_type: "nurture_reactivate",
  product_name: "Acme Analytics",
  sender_name: "Acme Team",
  contact: {
    name: "Alice Johnson",
    email: "alice@example.com",
    company: "Widgets Inc",
    plan: "pro",
    signup_date: "2025-01-15",
  },
  lifecycle: {
    state: "at_risk",
    tenure_days: 45,
    engagement_depth: "regular",
    payment_status: "paid",
  },
  tenure: {
    category: "growing",
    days: 45,
  },
  cadence: {
    current_7d: 1,
    previous_7d: 5,
    trend: "declining",
  },
  behavior: {
    last_action: "viewed_settings",
    most_used_features: ["reports", "exports"],
    recent_events: ["login", "viewed_settings"],
  },
  prior_contact: {
    last_message_date: "2025-02-01",
    last_message_type: "nurture_value",
    total_messages_sent: 3,
    messages_opened: 2,
    messages_clicked: 1,
  },
  first_contact: false,
  kb_context: "The dashboard feature provides real-time metrics and custom widgets.",
};

// ---------------------------------------------------------------------------
// Valid draft output
// ---------------------------------------------------------------------------

const validDraft = {
  subject: "You're missing out on real-time insights",
  body_markdown: "Hi Alice,\n\nI noticed you haven't tried our **dashboard** yet. It provides real-time metrics and custom widgets that many of our Pro users love.\n\nWould you like to give it a try?\n\nBest,\nThe Acme Team",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("draft()", () => {
  it("returns a validated draft on valid LLM output", async () => {
    const provider = mockProvider(JSON.stringify(validDraft));
    const result = await draft(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.subject).toBe(validDraft.subject);
      expect(result.draft.body_markdown).toBe(validDraft.body_markdown);
    }
  });

  it("returns usage info when provider supplies it", async () => {
    const usage = { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 };
    const provider = mockProvider(JSON.stringify(validDraft), usage);
    const result = await draft(provider, baseCtx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual(usage);
    }
  });

  it("rejects output with missing subject", async () => {
    const provider = mockProvider(JSON.stringify({ body_markdown: "Hello world" }));
    const result = await draft(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Draft validation failed");
      expect(result.error).toContain("subject");
    }
  });

  it("rejects output with missing body_markdown", async () => {
    const provider = mockProvider(JSON.stringify({ subject: "Hello" }));
    const result = await draft(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Draft validation failed");
      expect(result.error).toContain("body_markdown");
    }
  });

  it("rejects output with empty subject", async () => {
    const provider = mockProvider(JSON.stringify({ subject: "", body_markdown: "content" }));
    const result = await draft(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Draft validation failed");
    }
  });

  it("rejects output with empty body_markdown", async () => {
    const provider = mockProvider(JSON.stringify({ subject: "Hello", body_markdown: "" }));
    const result = await draft(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Draft validation failed");
    }
  });

  it("rejects unparseable LLM output", async () => {
    const provider = mockProvider("This is not JSON at all");
    const result = await draft(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid JSON");
    }
  });

  it("fails gracefully when LLM call throws", async () => {
    const provider = failingProvider(new Error("Rate limited"));
    const result = await draft(provider, baseCtx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("LLM call failed");
      expect(result.error).toContain("Rate limited");
    }
  });

  it("passes DRAFT_TEMPERATURE (0.7) to the provider", async () => {
    const provider = mockProvider(JSON.stringify(validDraft));
    await draft(provider, baseCtx);

    expect(provider.lastOpts).toBeDefined();
    expect(provider.lastOpts!.temperature).toBe(0.7);
    expect(DRAFT_TEMPERATURE).toBe(0.7);
  });

  it("passes JSON response_format to the provider", async () => {
    const provider = mockProvider(JSON.stringify(validDraft));
    await draft(provider, baseCtx);

    expect(provider.lastOpts!.response_format).toEqual({ type: "json_object" });
  });

  it("includes context fields in the messages sent to the provider", async () => {
    const provider = mockProvider(JSON.stringify(validDraft));
    await draft(provider, baseCtx);

    const messages = provider.lastOpts!.messages;
    expect(messages).toHaveLength(2);

    // System message exists
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("email content drafter");

    // User message contains context fields
    const userContent = messages[1]!.content;
    expect(userContent).toContain("INSTRUCTION:");
    expect(userContent).toContain(baseCtx.brain_instruction!);
    expect(userContent).toContain("ACTION TYPE: nurture_reactivate");
    expect(userContent).toContain("Alice Johnson");
    expect(userContent).toContain("Widgets Inc");
    expect(userContent).toContain("at_risk");
    expect(userContent).toContain("declining");
    expect(userContent).toContain("dashboard feature");
  });
});

describe("buildDraftMessages()", () => {
  it("includes brain_instruction in user message", () => {
    const messages = buildDraftMessages({ brain_instruction: "Write a welcome email" });
    const user = messages[1]!.content;
    expect(user).toContain("INSTRUCTION:\nWrite a welcome email");
  });

  it("includes action_type in user message", () => {
    const messages = buildDraftMessages({ action_type: "onboard_welcome" });
    const user = messages[1]!.content;
    expect(user).toContain("ACTION TYPE: onboard_welcome");
  });

  it("includes product and sender info", () => {
    const messages = buildDraftMessages({ product_name: "FooBar", sender_name: "FooBar Team" });
    const user = messages[1]!.content;
    expect(user).toContain("Product: FooBar");
    expect(user).toContain("Sender: FooBar Team");
  });

  it("includes contact details", () => {
    const messages = buildDraftMessages({
      contact: { name: "Bob", email: "bob@co.com", company: "Co", plan: "free", signup_date: "2025-03-01" },
    });
    const user = messages[1]!.content;
    expect(user).toContain("Name: Bob");
    expect(user).toContain("Email: bob@co.com");
    expect(user).toContain("Company: Co");
    expect(user).toContain("Plan: free");
    expect(user).toContain("Signed up: 2025-03-01");
  });

  it("includes lifecycle state", () => {
    const messages = buildDraftMessages({
      lifecycle: { state: "engaged", tenure_days: 10, engagement_depth: "light", payment_status: "trial" },
    });
    const user = messages[1]!.content;
    expect(user).toContain("State: engaged");
    expect(user).toContain("Tenure: 10 days");
    expect(user).toContain("Engagement: light");
    expect(user).toContain("Payment: trial");
  });

  it("includes cadence info", () => {
    const messages = buildDraftMessages({
      cadence: { current_7d: 2, previous_7d: 8, trend: "declining" },
    });
    const user = messages[1]!.content;
    expect(user).toContain("Current 7d visits: 2");
    expect(user).toContain("Previous 7d visits: 8");
    expect(user).toContain("Trend: declining");
  });

  it("includes behavior info", () => {
    const messages = buildDraftMessages({
      behavior: { last_action: "clicked_upgrade", most_used_features: ["reports"], recent_events: ["login"] },
    });
    const user = messages[1]!.content;
    expect(user).toContain("Last action: clicked_upgrade");
    expect(user).toContain("Most frequent events (30 days; product use and billing/lifecycle events mixed): reports");
    expect(user).toContain("Recent events: login");
  });

  it("includes prior contact history", () => {
    const messages = buildDraftMessages({
      prior_contact: { last_message_date: "2025-02-01", total_messages_sent: 5, messages_opened: 3, messages_clicked: 1 },
    });
    const user = messages[1]!.content;
    expect(user).toContain("Last message: 2025-02-01");
    expect(user).toContain("Total sent: 5");
    expect(user).toContain("Opened: 3");
    expect(user).toContain("Clicked: 1");
  });

  it("includes first_contact flag", () => {
    const messages = buildDraftMessages({ first_contact: true });
    const user = messages[1]!.content;
    expect(user).toContain("FIRST CONTACT: yes");
  });

  it("includes kb_context", () => {
    const messages = buildDraftMessages({ kb_context: "Our product helps teams collaborate." });
    const user = messages[1]!.content;
    expect(user).toContain("KNOWLEDGE BASE CONTEXT:\nOur product helps teams collaborate.");
  });

  it("includes brain_context as PRODUCT CONTEXT", () => {
    const messages = buildDraftMessages({ brain_context: "Acme is a kanban tool. No Gantt charts." });
    const user = messages[1]!.content;
    expect(user).toContain("PRODUCT CONTEXT:\nAcme is a kanban tool. No Gantt charts.");
  });

  it("omits PRODUCT CONTEXT when brain_context is absent", () => {
    const messages = buildDraftMessages({ product_name: "Acme" });
    const user = messages[1]!.content;
    expect(user).not.toContain("PRODUCT CONTEXT:");
  });

  it("produces minimal messages when context is empty", () => {
    const messages = buildDraftMessages({});
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    // User message should be empty or nearly empty (just newlines from join)
    expect(messages[1]!.content.trim()).toBe("");
  });

  it("system prompt states markdown-only constraint", () => {
    const messages = buildDraftMessages({});
    const system = messages[0]!.content;
    expect(system).toContain("No HTML tags");
    expect(system).toContain("No inline styles");
  });

  it("system prompt states the model does not decide whether to send", () => {
    const messages = buildDraftMessages({});
    const system = messages[0]!.content;
    expect(system).toContain("do not decide whether to send");
    expect(system).toContain("do not choose timing");
  });
});
