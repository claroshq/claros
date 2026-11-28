import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";

const ok = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });

function mockFetch(...responses: Response[]) {
  const fn = vi.fn(async () => responses.shift() ?? ok());
  vi.stubGlobal("fetch", fn);
  return fn;
}

const sentBody = (fn: ReturnType<typeof mockFetch>, i: number) =>
  JSON.parse((fn.mock.calls[i] as unknown as [string, RequestInit])[1].body as string);

const opts = { messages: [{ role: "user" as const, content: "hi" }], response_format: { type: "json_object" as const } };

afterEach(() => vi.unstubAllGlobals());

describe("OpenAICompatibleProvider response_format", () => {
  it("sends json_object to OpenAI-style endpoints", async () => {
    const fn = mockFetch(ok());
    await new OpenAICompatibleProvider({ apiKey: "k", baseUrl: "https://api.openai.com/v1", model: "m" }).complete(opts);
    expect(sentBody(fn, 0).response_format).toEqual({ type: "json_object" });
  });

  it("never sends response_format to Anthropic", async () => {
    const fn = mockFetch(ok());
    await new OpenAICompatibleProvider({ apiKey: "k", baseUrl: "https://api.anthropic.com/v1/", model: "m" }).complete(opts);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sentBody(fn, 0)).not.toHaveProperty("response_format");
  });

  it("retries once without response_format when an endpoint rejects it", async () => {
    const rejected = new Response(
      JSON.stringify({ error: { message: "response_format.type: Input should be 'json_schema'" } }),
      { status: 400 },
    );
    const fn = mockFetch(rejected, ok());
    const r = await new OpenAICompatibleProvider({ apiKey: "k", baseUrl: "https://proxy.example/v1", model: "m" }).complete(opts);
    expect(r.content).toBe("{}");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sentBody(fn, 0).response_format).toEqual({ type: "json_object" });
    expect(sentBody(fn, 1)).not.toHaveProperty("response_format");
  });

  it("still throws other 400s without retrying", async () => {
    const fn = mockFetch(new Response("bad model", { status: 400 }));
    await expect(
      new OpenAICompatibleProvider({ apiKey: "k", baseUrl: "https://api.openai.com/v1", model: "m" }).complete(opts),
    ).rejects.toThrow(/400/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
