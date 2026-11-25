/**
 * worker-mailer SMTP error classification (unit, no sockets).
 */
import { describe, it, expect } from "vitest";
import { classifySmtpError } from "../src/smtp-errors.js";

describe("classifySmtpError", () => {
  it("treats 5xx replies as permanent and 4xx as transient", () => {
    expect(classifySmtpError(new Error("550 5.1.1 mailbox unavailable"))).toMatchObject({ success: false, permanent: true });
    expect(classifySmtpError(new Error("421 4.7.0 try again later"))).toMatchObject({ success: false, permanent: false });
  });

  it("treats connection errors as transient and masks credentials", () => {
    const r = classifySmtpError(new Error("Socket timeout, password=hunter2"));
    expect(r).toMatchObject({ success: false, permanent: false });
    expect(r.error).not.toContain("hunter2");
    expect(classifySmtpError(new Error("connect ECONNREFUSED 10.0.0.1:587"))).toMatchObject({ permanent: false });
  });
});
