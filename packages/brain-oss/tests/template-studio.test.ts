/**
 * Template studio turn with a scripted provider: applied changes are
 * validated (one repair round), proposals and off-topic answers carry no
 * template, and the prompt keeps scope, contract and findings in view.
 */
import { describe, it, expect } from "vitest";
import { BUILTIN_LAYOUTS, checkLayoutSource } from "@claros/core";
import {
  assistTemplate,
  buildTemplateStudioMessages,
  parseStudioOutput,
  TEMPLATE_STUDIO_SYSTEM_PROMPT,
  type LlmProvider,
  type CompletionOptions,
} from "../src/index.js";

const classic = BUILTIN_LAYOUTS.find((b) => b.key === "classic")!;

function scripted(...answers: string[]): LlmProvider & { calls: CompletionOptions[] } {
  const calls: CompletionOptions[] = [];
  return {
    calls,
    async complete(opts) {
      calls.push(opts);
      const content = answers[calls.length - 1];
      if (content === undefined) throw new Error("unexpected call");
      return { content, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    },
  };
}

const ctx = (message: string, history: { role: "user" | "assistant"; content: string }[] = []) => ({
  source: classic.source,
  width: "narrow" as const,
  productName: "Acme",
  history,
  message,
  findings: checkLayoutSource(classic.source),
});

const answer = (reply: string, decision: string, template?: string) =>
  `<reply>${reply}</reply>\n<decision>${decision}</decision>${template ? `\n<template>\n${template}\n</template>` : ""}`;

describe("assistTemplate", () => {
  it("returns an applied, valid template with its findings", async () => {
    const changed = classic.source.replace("padding:24px 40px 40px 40px", "padding:32px 40px 48px 40px");
    const p = scripted(answer("More space around the text.", "applied", changed));
    const r = await assistTemplate(p, ctx("more breathing room"));
    expect(r).toMatchObject({ decision: "applied", reply: "More space around the text.", source: changed, newFindings: [], tokens: 150 });
    expect(p.calls[0]!.temperature).toBe(0.2);
  });

  it("reports findings the change introduced", async () => {
    const changed = classic.source.replace('<td class="email-container" style="', '<td class="email-container" style="border-radius:12px;');
    const r = await assistTemplate(scripted(answer("Rounded the header. Outlook for Windows shows square corners.", "applied", changed)), ctx("round the corners"));
    expect(r.decision).toBe("applied");
    expect(r.newFindings).toEqual(["border_radius"]);
  });

  it("repairs a template that dropped the compliance footer, once", async () => {
    const broken = classic.source.replace("{{compliance_footer}}", "");
    const p = scripted(answer("Removed the footer.", "applied", broken), answer("Kept the footer; it is required.", "applied", classic.source));
    const r = await assistTemplate(p, ctx("remove the footer"));
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]!.messages.at(-1)!.content).toContain("{{compliance_footer}}");
    expect(r).toMatchObject({ decision: "applied", source: classic.source, reply: "Kept the footer; it is required.", tokens: 300 });
  });

  it("fails without changing anything when the repair is still invalid", async () => {
    const broken = classic.source.replace("{{body}}", "");
    const r = await assistTemplate(scripted(answer("a", "applied", broken), answer("b", "applied", broken)), ctx("x"));
    expect(r.decision).toBe("failed");
    expect(r.source).toBeNull();
    expect(r.reply).toContain("Nothing was changed");
  });

  it("passes proposals and off-topic answers through without a template", async () => {
    const proposed = await assistTemplate(scripted(answer("Flexbox columns collapse in Outlook for Windows. Use a two-cell table instead?", "proposed")), ctx("put logo and links side by side with flexbox"));
    expect(proposed).toMatchObject({ decision: "proposed", source: null });
    const off = await assistTemplate(scripted(answer("I only work on this email template.", "off_topic")), ctx("what is the capital of France?"));
    expect(off).toMatchObject({ decision: "off_topic", source: null, reply: "I only work on this email template." });
  });

  it("never applies a template sent with a non-applied decision", async () => {
    const r = await assistTemplate(scripted(answer("Here is an idea.", "proposed", classic.source.replace("40px", "8px"))), ctx("x"));
    expect(r).toMatchObject({ decision: "proposed", source: null });
  });
});

describe("parseStudioOutput", () => {
  it("strips a fenced template and infers applied", () => {
    const p = parseStudioOutput("<reply>ok</reply><template>```html\n<html></html>\n```</template>");
    expect(p).toEqual({ reply: "ok", decision: "applied", template: "<html></html>" });
  });
  it("treats untagged text as a reply", () => {
    expect(parseStudioOutput("Just text")).toEqual({ reply: "Just text", decision: "answered", template: null });
  });
});

describe("prompt", () => {
  it("states scope, the contract, client knowledge and the output format", () => {
    for (const s of ["off_topic", "{{compliance_footer}}", "Outlook for Windows", "Gmail", "Apple Mail", "ghost table", "<decision>", "proposed"]) {
      expect(TEMPLATE_STUDIO_SYSTEM_PROMPT).toContain(s);
    }
  });
  it("sends the template and findings in the last turn and caps the history", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `t${i}` }));
    const msgs = buildTemplateStudioMessages({ ...ctx("make it blue", history), source: classic.source });
    expect(msgs[0]!.role).toBe("system");
    expect(msgs).toHaveLength(1 + 12 + 1);
    expect(msgs.at(-1)!.content).toContain("<current_template>");
    expect(msgs.at(-1)!.content).toContain("make it blue");
    expect(msgs.at(-1)!.content).toContain("CURRENT FINDINGS");
  });
});
