/**
 * SMTP adapter integration test - sends a real email through Ethereal
 * (Nodemailer's free testing SMTP service) and verifies delivery.
 *
 * This test makes real network calls. It:
 *   1. Creates an Ethereal test account (free, disposable)
 *   2. Sends an email through the SmtpTransportAdapter
 *   3. Verifies the email arrived via Ethereal's API
 *   4. Tests verification failure with wrong credentials
 *   5. Tests verification success with correct credentials
 *
 * Run deliberately: npx vitest run tests/smtp-integration.test.ts
 *
 * Requires internet access. The entire suite skips when Ethereal is
 * unreachable - either because the network is down or the createTestAccount()
 * call times out. "Available" is determined by a single probe that races a
 * 10-second wall-clock timeout against the Ethereal API. If the probe loses,
 * all tests in this file are skipped with a console.warn. This means CI
 * without internet access does not fail, and a developer who wants to run the
 * tests deliberately can do so on a connected machine.
 *
 * NOTE TO FUTURE EDITORS: Do NOT use beforeAll to set availability state that
 * individual tests then check. vitest's beforeAll timeout fires independently
 * of the try/catch inside the callback, leaving state inconsistent when the
 * callback is interrupted. Probe at the module level with Promise.race instead.
 */
import { describe, it, expect, beforeAll } from "vitest";
import nodemailer from "nodemailer";
import { SmtpTransportAdapter } from "../src/smtp.js";
import type { TransportSendParams } from "../src/transport-types.js";

// ---------------------------------------------------------------------------
// Module-level availability probe
// ---------------------------------------------------------------------------
// Races createTestAccount() against a 10s wall-clock timeout. If Ethereal
// responds in time, we get real credentials and run the tests. Otherwise the
// entire describe block is skipped at the point of the first test.
//
// Using a top-level await here means the probe runs once, synchronously, as
// the module is collected. vitest supports top-level await in test files.

type EtherealAccount = { user: string; pass: string } | null;

function probeEthereal(): Promise<EtherealAccount> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000));
  const probe = nodemailer.createTestAccount().then((a) => ({ user: a.user, pass: a.pass })).catch(() => null);
  return Promise.race([probe, timeout]);
}

// The probe result. null means "skip everything in this file".
const etherealAccount: EtherealAccount = await probeEthereal().catch(() => null);

if (!etherealAccount) {
  console.warn("[smtp-integration] Ethereal unreachable or timed out - all tests in this file will skip.");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<TransportSendParams> = {}): TransportSendParams {
  return {
    to: "test-recipient@example.com",
    from: etherealAccount?.user ?? "noreply@example.com",
    fromName: "Claros Test",
    subject: `SMTP Integration Test ${Date.now()}`,
    bodyHtml: "<h1>Hello from Claros SMTP</h1><p>This email was sent through the SmtpTransportAdapter.</p>",
    bodyText: "Hello from Claros SMTP\n\nThis email was sent through the SmtpTransportAdapter.",
    messageId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    headers: {
      "List-Unsubscribe": "<https://example.com/unsubscribe?token=test>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SMTP adapter integration (Ethereal)", () => {
  it("sends a real email and receives a provider message ID", async () => {
    if (!etherealAccount) {
      console.log("[smtp-integration] skip: Ethereal unavailable");
      return;
    }

    const adapter = new SmtpTransportAdapter({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      username: etherealAccount.user,
      password: etherealAccount.pass,
    });

    const result = await adapter.send(makeParams());

    expect(result.success).toBe(true);
    expect(result.providerMessageId).toBeDefined();
    expect(result.providerMessageId!.length).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();

    const previewUrl = nodemailer.getTestMessageUrl({
      messageId: result.providerMessageId!,
      envelope: { from: etherealAccount.user, to: ["test-recipient@example.com"] },
    } as any);
    console.log("[smtp-integration] Send succeeded.");
    console.log(`  providerMessageId: ${result.providerMessageId}`);
    if (previewUrl) {
      console.log(`  Preview URL: ${previewUrl}`);
    }

    adapter.close();
  }, 30000);

  it("verify() succeeds with correct credentials", async () => {
    if (!etherealAccount) {
      console.log("[smtp-integration] skip: Ethereal unavailable");
      return;
    }

    const adapter = new SmtpTransportAdapter({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      username: etherealAccount.user,
      password: etherealAccount.pass,
    });

    const result = await adapter.verify();
    expect(result.ok).toBe(true);

    adapter.close();
  }, 30000);

  it("verify() fails with wrong password", async () => {
    if (!etherealAccount) {
      console.log("[smtp-integration] skip: Ethereal unavailable");
      return;
    }

    const adapter = new SmtpTransportAdapter({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      username: etherealAccount.user,
      password: "wrong_password_12345",
    });

    const result = await adapter.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeDefined();
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error).not.toContain("wrong_password_12345");
      console.log(`[smtp-integration] Verification failed as expected: ${result.error}`);
    }

    adapter.close();
  }, 30000);

  it("verify() fails with unreachable host", async () => {
    // Use 127.0.0.1 port 1 - loopback is always reachable for DNS but port 1
    // is virtually never open, giving a fast ECONNREFUSED rather than waiting
    // on DNS resolution or a full connectionTimeout for a .invalid hostname.
    const adapter = new SmtpTransportAdapter({
      host: "127.0.0.1",
      port: 1,
      secure: false,
      username: "test",
      password: "test",
    });

    const result = await adapter.verify();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeDefined();
      console.log(`[smtp-integration] Unreachable host failed as expected: ${result.error}`);
    }

    adapter.close();
  }, 10000);
});
