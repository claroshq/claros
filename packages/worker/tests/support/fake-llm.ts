/**
 * A fake OpenAI-compatible chat completions endpoint on 127.0.0.1 for engine
 * tests (no real LLM is ever called). The answer is chosen by the kind of
 * call, read from the system prompt: decide, draft, assess, choose, opening.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { encrypt, parseEncryptionKey } from "@claros/adapters";

export type LlmKind = "decide" | "draft" | "assess" | "choose" | "opening" | "other";
export interface LlmCall {
  kind: LlmKind;
  system: string;
  user: string;
}

export const TEST_ENCRYPTION_KEY = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";

function kindOf(system: string): LlmKind {
  if (system.includes("decision engine")) return "decide";
  if (system.includes("content drafter")) return "draft";
  if (system.includes("quality gate")) return "assess";
  if (system.includes("choose step")) return "choose";
  if (system.includes("opening line")) return "opening";
  return "other";
}

export interface FakeLlm {
  url: string;
  calls: LlmCall[];
  answer: (call: LlmCall) => unknown;
  close(): Promise<void>;
}

export const DEFAULT_ANSWERS: Record<LlmKind, unknown> = {
  decide: { action: "contact", reasoning: "fits" },
  draft: { subject: "Hello", body_markdown: "Hi there, a short note." },
  assess: { verdict: "pass", reasoning: "useful" },
  choose: { choice: "none", reason: "nothing fits" },
  opening: { opening: "Glad you are here." },
  other: {},
};

export async function startFakeLlm(): Promise<FakeLlm> {
  const fake: FakeLlm = {
    url: "",
    calls: [],
    answer: (call) => DEFAULT_ANSWERS[call.kind],
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not here" } }));
        return;
      }
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      const user = body.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
      const call: LlmCall = { kind: kindOf(system), system, user };
      fake.calls.push(call);
      const content = JSON.stringify(fake.answer(call));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: randomUUID(), choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return fake;
}

/** Insert an active LLM config for a product pointing at the fake. */
export async function useFakeLlm(b: { db: any; schema: any }, tenantId: string, fake: FakeLlm): Promise<void> {
  process.env.ENCRYPTION_KEY ??= TEST_ENCRYPTION_KEY;
  const key = parseEncryptionKey(process.env.ENCRYPTION_KEY);
  const config = encrypt(JSON.stringify({ apiKey: "sk-test", baseUrl: fake.url, model: "fake-model" }), key);
  await b.db.insert(b.schema.llmConfigs).values({ tenantId, provider: "openai", config, isActive: true });
}
