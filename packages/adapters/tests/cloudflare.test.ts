/**
 * Unit tests for the Cloudflare Email Service adapter. No network: the REST
 * path gets a fake fetch, the binding path a fake send_email binding.
 */
import { describe, it, expect, vi } from "vitest";
import { CloudflareTransportAdapter, type CloudflareSendEmailBinding } from "../src/cloudflare.js";
import { resolveTransportAdapter } from "../src/resolve-transport.js";
import { setTransportRuntime } from "../src/transport-runtime.js";
import { encrypt, parseEncryptionKey } from "../src/crypto.js";
import type { TransportSendParams } from "../src/transport-types.js";

const params: TransportSendParams = {
  to: "ann@example.com",
  from: "receipts@example.com",
  fromName: "Receipts",
  replyTo: "help@example.com",
  subject: "Your receipt",
  bodyHtml: "<p>Thanks</p>",
  bodyText: "Thanks",
  messageId: "m-1",
  headers: { "List-Unsubscribe": "<https://x/u>" },
  tags: { claros_message_id: "m-1" },
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("CloudflareTransportAdapter (REST API)", () => {
  it("posts to the account's send endpoint with a bearer token and named from", async () => {
    const fetch = fakeFetch(200, { success: true, errors: [], result: { message_id: "<abc@x>" } });
    const adapter = new CloudflareTransportAdapter({ accountId: "acc", apiToken: "tok", fetch: fetch as never });
    expect(await adapter.send(params)).toEqual({ success: true, providerMessageId: "<abc@x>" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/email/sending/send");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({
      from: { address: "receipts@example.com", name: "Receipts" },
      to: "ann@example.com",
      subject: "Your receipt",
      html: "<p>Thanks</p>",
      text: "Thanks",
      reply_to: "help@example.com",
      headers: { "List-Unsubscribe": "<https://x/u>" },
    });
  });

  it("classifies 4xx as permanent and 429 / 5xx as transient, without the token in the error", async () => {
    const bad = new CloudflareTransportAdapter({
      accountId: "acc", apiToken: "secret-token",
      fetch: fakeFetch(403, { success: false, errors: [{ code: 10203, message: "email.sending.error.email.sending_disabled" }] }) as never,
    });
    const r1 = await bad.send(params);
    expect(r1).toMatchObject({ success: false, permanent: true });
    expect(r1.error).toContain("10203");
    expect(r1.error).not.toContain("secret-token");
    for (const status of [429, 500, 503]) {
      const a = new CloudflareTransportAdapter({ accountId: "acc", apiToken: "t", fetch: fakeFetch(status, { success: false, errors: [] }) as never });
      expect(await a.send(params)).toMatchObject({ success: false, permanent: false });
    }
    const network = new CloudflareTransportAdapter({
      accountId: "acc", apiToken: "t", fetch: vi.fn(async () => { throw new Error("boom"); }) as never,
    });
    expect(await network.send(params)).toMatchObject({ success: false, permanent: false });
  });

  it("fails permanently without credentials or binding", async () => {
    expect(await new CloudflareTransportAdapter({}).send(params)).toMatchObject({ success: false, permanent: true });
  });
});

describe("CloudflareTransportAdapter (send_email binding)", () => {
  it("sends through the binding with replyTo and a named from", async () => {
    const send = vi.fn(async () => ({ messageId: "bind-1" }));
    const adapter = new CloudflareTransportAdapter({ binding: { send } as CloudflareSendEmailBinding });
    expect(await adapter.send(params)).toEqual({ success: true, providerMessageId: "bind-1" });
    expect(send).toHaveBeenCalledWith({
      from: { email: "receipts@example.com", name: "Receipts" },
      to: "ann@example.com",
      subject: "Your receipt",
      html: "<p>Thanks</p>",
      text: "Thanks",
      replyTo: "help@example.com",
      headers: { "List-Unsubscribe": "<https://x/u>" },
    });
  });

  it("maps binding error codes: rate limits transient, sender errors permanent", async () => {
    const failing = (code?: string, ctor: ErrorConstructor = Error) =>
      new CloudflareTransportAdapter({
        binding: { send: async () => { throw Object.assign(new ctor("x"), code ? { code } : {}); } },
      });
    expect(await failing("E_RATE_LIMIT_EXCEEDED").send(params)).toMatchObject({ permanent: false });
    expect(await failing("E_SENDER_NOT_VERIFIED").send(params)).toMatchObject({ permanent: true });
    expect(await failing(undefined, TypeError).send(params)).toMatchObject({ permanent: true });
  });
});

describe("resolveTransportAdapter: cloudflare", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");

  it("builds the REST adapter from the decrypted config, and uses a registered binding when no credentials are stored", async () => {
    const config = encrypt(JSON.stringify({ accountId: "acc", apiToken: "tok" }), parseEncryptionKey(KEY));
    const rest = resolveTransportAdapter("cloudflare", config, KEY);
    expect(rest.ok && rest.transport.adapter).toBeInstanceOf(CloudflareTransportAdapter);

    const send = vi.fn(async () => ({ messageId: "b" }));
    setTransportRuntime({ cloudflareBinding: { send } });
    try {
      const bare = encrypt(JSON.stringify({}), parseEncryptionKey(KEY));
      const viaBinding = resolveTransportAdapter("cloudflare", bare, KEY);
      expect(viaBinding.ok).toBe(true);
      if (viaBinding.ok) await viaBinding.transport.adapter.send(params);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      setTransportRuntime({});
    }
  });

  it("keeps stored credentials on the REST API when the Worker also has the binding", async () => {
    const send = vi.fn(async () => ({ messageId: "b" }));
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, result: { message_id: "r" } }), { status: 200 }));
    const adapter = new CloudflareTransportAdapter({ accountId: "acc", apiToken: "tok", binding: { send }, fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await adapter.send(params)).toMatchObject({ success: true, providerMessageId: "r" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("uses a registered SMTP factory instead of nodemailer", () => {
    const config = encrypt(JSON.stringify({ host: "smtp.x", port: 587, secure: false }), parseEncryptionKey(KEY));
    const fake = { send: vi.fn() };
    setTransportRuntime({ smtp: () => fake });
    try {
      const r = resolveTransportAdapter("smtp", config, KEY);
      expect(r.ok && r.transport.adapter).toBe(fake);
    } finally {
      setTransportRuntime({});
    }
  });
});
