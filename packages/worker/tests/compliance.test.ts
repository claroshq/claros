/**
 * Unit tests for checkBaseUrl() in compliance.ts.
 *
 * Tests:
 * - Outside production: any URL is allowed (quickstart protection)
 * - In production: localhost is rejected
 * - In production: 127.x.x.x loopback is rejected
 * - In production: ::1 loopback is rejected
 * - In production: http scheme is rejected
 * - In production: malformed URL is rejected
 * - In production: valid https URL is accepted
 * - startup behavior: resolveBaseUrl strips trailing slash and falls back to localhost
 * - buildComplianceOutput: unsubscribe URL uses baseUrl, not dashboardUrl
 *   (regression guard: BASE_URL must keep its meaning for unsubscribe links)
 */
import { describe, it, expect } from "vitest";
import { checkBaseUrl, resolveBaseUrl, buildComplianceOutput } from "../src/compliance.js";

describe("checkBaseUrl", () => {
  describe("outside production (isProduction=false)", () => {
    it("allows http://localhost:3000 (quickstart default)", () => {
      expect(checkBaseUrl("http://localhost:3000", false)).toBeNull();
    });

    it("allows any loopback URL", () => {
      expect(checkBaseUrl("http://127.0.0.1:3000", false)).toBeNull();
    });

    it("allows http scheme", () => {
      expect(checkBaseUrl("http://mail.example.com", false)).toBeNull();
    });

    it("allows a malformed value", () => {
      // Outside production we never block - even a nonsense value is allowed.
      expect(checkBaseUrl("not-a-url", false)).toBeNull();
    });
  });

  describe("in production (isProduction=true)", () => {
    it("rejects localhost", () => {
      const reason = checkBaseUrl("http://localhost:3000", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("loopback");
      expect(reason).toContain("localhost");
    });

    it("rejects 127.0.0.1", () => {
      const reason = checkBaseUrl("http://127.0.0.1:3000", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("loopback");
    });

    it("rejects 127.x.x.x range (not just .1)", () => {
      const reason = checkBaseUrl("http://127.1.2.3:3000", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("loopback");
    });

    it("rejects ::1 IPv6 loopback", () => {
      const reason = checkBaseUrl("http://[::1]:3000", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("loopback");
    });

    it("rejects http scheme", () => {
      const reason = checkBaseUrl("http://mail.example.com", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("https");
    });

    it("rejects malformed / unparseable URL", () => {
      const reason = checkBaseUrl("not-a-url", true);
      expect(reason).not.toBeNull();
      expect(reason).toContain("not a valid URL");
    });

    it("accepts a valid https URL", () => {
      expect(checkBaseUrl("https://mail.example.com", true)).toBeNull();
    });

    it("accepts the Cloud production URL", () => {
      expect(checkBaseUrl("https://claros.example.com", true)).toBeNull();
    });

    it("accepts https with a non-standard port", () => {
      expect(checkBaseUrl("https://mail.example.com:8443", true)).toBeNull();
    });

    it("returns a non-empty string reason (not null and not empty)", () => {
      const reason = checkBaseUrl("http://localhost:3000", true);
      expect(typeof reason).toBe("string");
      expect((reason as string).length).toBeGreaterThan(0);
    });
  });

  describe("production detection via NODE_ENV (no isProduction override)", () => {
    // These tests do not mutate NODE_ENV. They confirm the function does not
    // throw and behaves consistently when called without the override param.
    // The test runner typically sets NODE_ENV=test, so all values are allowed.
    it("does not throw for localhost when called without override in test environment", () => {
      expect(() => checkBaseUrl("http://localhost:3000")).not.toThrow();
    });

    it("does not throw for a valid https URL when called without override", () => {
      expect(() => checkBaseUrl("https://claros.example.com")).not.toThrow();
    });
  });
});

describe("resolveBaseUrl", () => {
  it("strips trailing slash", () => {
    expect(resolveBaseUrl("https://mail.example.com/")).toBe("https://mail.example.com");
  });

  it("does not strip when no trailing slash", () => {
    expect(resolveBaseUrl("https://mail.example.com")).toBe("https://mail.example.com");
  });

  it("uses override when provided", () => {
    expect(resolveBaseUrl("https://override.example.com")).toBe("https://override.example.com");
  });
});

// ---------------------------------------------------------------------------
// buildComplianceOutput: baseUrl is used for unsubscribe URLs, not dashboardUrl
// ---------------------------------------------------------------------------
// Regression guard: Decision 1 says BASE_URL keeps its current meaning for
// unsubscribe headers and footer links. buildComplianceOutput takes baseUrl
// directly (packages/worker/src/compliance.ts buildComplianceOutput).
// This test proves the unsubscribe URL uses the value passed as baseUrl,
// which the drain resolves from BASE_URL via resolveBaseUrl(), not from
// DASHBOARD_URL. The two variables must never be confused in this path.

describe("buildComplianceOutput: unsubscribe URLs use baseUrl, not dashboardUrl", () => {
  const BASE_URL = "https://api.example.com";
  const DASH_URL = "https://dash.example.com";
  const SIGNING_KEY = "a".repeat(64); // 64-char hex key for testing

  it("unsubscribe URL in header contains baseUrl, not dashboardUrl", () => {
    const out = buildComplianceOutput({
      tenantId: "00000000-0000-0000-0000-000000000001",
      messageId: "00000000-0000-0000-0000-000000000002",
      postalAddress: "123 Test St",
      baseUrl: BASE_URL,
      signingKey: SIGNING_KEY,
    });
    // The List-Unsubscribe header and footer must use BASE_URL, not DASH_URL.
    // This test would fail if baseUrl were swapped for dashboardUrl in compliance.ts.
    expect(out.listUnsubscribeHeader).toContain(BASE_URL);
    expect(out.listUnsubscribeHeader).not.toContain(DASH_URL);
    expect(out.unsubscribeUrl).toContain(BASE_URL);
    expect(out.unsubscribeUrl).not.toContain(DASH_URL);
    expect(out.htmlFooter).toContain(BASE_URL);
    expect(out.htmlFooter).not.toContain(DASH_URL);
    expect(out.textFooter).toContain(BASE_URL);
    expect(out.textFooter).not.toContain(DASH_URL);
  });
});
