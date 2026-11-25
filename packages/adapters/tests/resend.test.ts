/**
 * Unit tests for the Resend transport adapter.
 *
 * No network calls. fetch() is replaced with a vi.stubGlobal mock.
 *
 * Coverage:
 *   - Successful send returns provider message ID from response body
 *   - Successful send with no body ID returns success without provider ID
 *   - Permanent failure (4xx non-429) marks permanent=true
 *   - Transient failure (429, 5xx) marks permanent=false
 *   - Network error (fetch throws) returns transient failure
 *   - Credentials do NOT appear in any error message
 *   - Recipient address does NOT appear in any error message
 *   - Message body/HTML is NOT included in any log or return value
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResendTransportAdapter } from "../src/resend.js";
import type { TransportSendParams } from "../src/transport-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "re_test_key_do_not_use_outside_tests";
const TEST_RECIPIENT = "recipient@example.com";

/** Minimal send params used across tests. */
function makeParams(overrides: Partial<TransportSendParams> = {}): TransportSendParams {
  return {
    to: TEST_RECIPIENT,
    from: "noreply@example.com",
    fromName: "Claros",
    subject: "Test subject",
    bodyHtml: "<p>Test body HTML</p>",
    bodyText: "Test body text",
    messageId: "00000000-0000-0000-0000-000000000001",
    headers: {
      "List-Unsubscribe": "<https://mail.example.com/unsubscribe/one-click?token=test>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    ...overrides,
  };
}

/** Build a mock Response with the given status and body. */
function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResendTransportAdapter", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Successful send
  // -------------------------------------------------------------------------

  describe("successful send", () => {
    it("returns success=true and the provider message ID from the response body", async () => {
      const providerId = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, { id: providerId })));

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      const result = await adapter.send(makeParams());

      expect(result.success).toBe(true);
      expect(result.providerMessageId).toBe(providerId);
      expect(result.error).toBeUndefined();
      expect(result.permanent).toBeUndefined();
    });

    it("returns success=true even when response body has no id field", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(200, {})));

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      const result = await adapter.send(makeParams());

      expect(result.success).toBe(true);
      expect(result.providerMessageId).toBeUndefined();
    });

    it("passes the message ID as the Idempotency-Key header", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { id: "msg-id" }));
      vi.stubGlobal("fetch", fetchMock);

      const messageId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      await adapter.send(makeParams({ messageId }));

      const call = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = call[1].headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe(messageId);
    });

    it("sends to the correct Resend API URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { id: "msg-id" }));
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      await adapter.send(makeParams());

      const call = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(call[0]).toBe("https://api.resend.com/emails");
      expect(call[1].method).toBe("POST");
    });

    it("sends reply_to and tags (name/value pairs) when given, and omits them otherwise", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { id: "msg-id" }));
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      await adapter.send(
        makeParams({
          replyTo: "support@example.com",
          tags: { claros_tenant: "t-1", claros_message_id: "m-1", claros_flow: "flow 1/x" },
        }),
      );
      await adapter.send(makeParams());

      const withExtras = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(withExtras.reply_to).toBe("support@example.com");
      expect(withExtras.tags).toEqual([
        { name: "claros_tenant", value: "t-1" },
        { name: "claros_message_id", value: "m-1" },
        // Resend allows only letters, digits, _ and - in tag values.
        { name: "claros_flow", value: "flow_1_x" },
      ]);
      const plain = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
      expect(plain).not.toHaveProperty("reply_to");
      expect(plain).not.toHaveProperty("tags");
    });

    it("includes fromName in the from field when provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { id: "msg-id" }));
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      await adapter.send(makeParams({ fromName: "Claros Notifications", from: "no-reply@example.com" }));

      const call = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.from).toBe("Claros Notifications <no-reply@example.com>");
    });

    it("uses plain from address when fromName is not provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { id: "msg-id" }));
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      await adapter.send(makeParams({ fromName: undefined, from: "no-reply@example.com" }));

      const call = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.from).toBe("no-reply@example.com");
    });
  });

  // -------------------------------------------------------------------------
  // Permanent failures (4xx that are not 429/409)
  // -------------------------------------------------------------------------

  describe("permanent failures", () => {
    const permanentCases: Array<{ status: number; name: string; description: string }> = [
      { status: 400, name: "validation_error", description: "malformed request" },
      { status: 401, name: "missing_api_key", description: "auth header absent" },
      { status: 401, name: "invalid_api_key", description: "wrong key" },
      { status: 403, name: "invalid_api_key", description: "API key invalid" },
      { status: 403, name: "validation_error", description: "unverified domain" },
      { status: 422, name: "invalid_from_address", description: "bad from address" },
      { status: 422, name: "missing_required_field", description: "required field absent" },
      { status: 451, name: "security_error", description: "message/recipient flagged" },
    ];

    for (const { status, name, description } of permanentCases) {
      it(`returns permanent=true for ${status} ${name} (${description})`, async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
          mockResponse(status, { name, message: `Test error: ${description}`, statusCode: status }),
        ));

        const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
        const result = await adapter.send(makeParams());

        expect(result.success).toBe(false);
        expect(result.permanent).toBe(true);
        expect(result.error).toBeDefined();
      });
    }
  });

  // -------------------------------------------------------------------------
  // Transient failures (429, 409, 5xx)
  // -------------------------------------------------------------------------

  describe("transient failures", () => {
    const transientCases: Array<{ status: number; name: string; description: string }> = [
      { status: 429, name: "rate_limit_exceeded", description: "rate limit" },
      { status: 429, name: "daily_quota_exceeded", description: "daily quota hit" },
      { status: 429, name: "monthly_quota_exceeded", description: "monthly quota hit" },
      { status: 409, name: "concurrent_idempotent_requests", description: "request in-flight" },
      { status: 409, name: "invalid_idempotent_request", description: "same key different payload" },
      { status: 500, name: "application_error", description: "server error" },
      { status: 500, name: "internal_server_error", description: "internal error" },
    ];

    for (const { status, name, description } of transientCases) {
      it(`returns permanent=false for ${status} ${name} (${description})`, async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
          mockResponse(status, { name, message: `Test error: ${description}`, statusCode: status }),
        ));

        const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
        const result = await adapter.send(makeParams());

        expect(result.success).toBe(false);
        expect(result.permanent).toBe(false);
        expect(result.error).toBeDefined();
      });
    }
  });

  // -------------------------------------------------------------------------
  // Network errors
  // -------------------------------------------------------------------------

  describe("network errors", () => {
    it("returns transient failure when fetch throws (network error)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      const result = await adapter.send(makeParams());

      expect(result.success).toBe(false);
      expect(result.permanent).toBe(false);
      expect(result.error).toContain("ECONNREFUSED");
    });

    it("returns transient failure when fetch throws a timeout error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Request timed out")));

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      const result = await adapter.send(makeParams());

      expect(result.success).toBe(false);
      expect(result.permanent).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Security: credentials, recipient address, and body must NOT appear in logs
  // -------------------------------------------------------------------------

  describe("credential and data leakage prevention", () => {
    it("does not include the API key in the error message on failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        mockResponse(401, { name: "invalid_api_key", message: "API key is invalid", statusCode: 401 }),
      ));

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      const result = await adapter.send(makeParams());

      expect(result.success).toBe(false);
      // The API key must not leak into the error message.
      expect(result.error).not.toContain(TEST_API_KEY);
    });

    it("does not include the recipient address in the error message on failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        mockResponse(422, { name: "invalid_from_address", message: "Invalid from field", statusCode: 422 }),
      ));

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      const result = await adapter.send(makeParams({ to: TEST_RECIPIENT }));

      expect(result.success).toBe(false);
      // The recipient address must not leak into the error message.
      expect(result.error).not.toContain(TEST_RECIPIENT);
    });

    it("does not include the API key in the Authorization header value in the result", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { id: "ok" }));
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      const result = await adapter.send(makeParams());

      // Result itself carries no credential.
      expect(JSON.stringify(result)).not.toContain(TEST_API_KEY);
    });

    it("does not include the HTML body in the returned result", async () => {
      const sensitiveHtml = "<p>SENSITIVE_CONTENT_12345</p>";
      const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { id: "ok" }));
      vi.stubGlobal("fetch", fetchMock);

      const adapter = new ResendTransportAdapter({ apiKey: TEST_API_KEY });
      const result = await adapter.send(makeParams({ bodyHtml: sensitiveHtml }));

      // The body is sent to Resend but must not appear in the result object.
      expect(JSON.stringify(result)).not.toContain("SENSITIVE_CONTENT_12345");
    });
  });
});
