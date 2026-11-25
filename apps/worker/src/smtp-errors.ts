/**
 * SMTP failure classification for the worker-mailer adapter, the same rules
 * as the nodemailer adapter: 5xx replies are permanent, 4xx replies and
 * connection errors transient. worker-mailer reports server replies in the
 * error message, so the code is read from there. Credentials are masked.
 */
import type { TransportSendResult } from "@claros/adapters";

export function classifySmtpError(err: unknown): TransportSendResult {
  const message = (err instanceof Error ? err.message : String(err))
    .replace(/pass(?:word)?[:=]\s*\S+/gi, "pass=***")
    .replace(/user[:=]\s*\S+/gi, "user=***");
  // A reply code stands alone ("550 5.1.1 ..."); ports like ":587" do not count.
  const code = /(?:^|\s)([45]\d{2})(?:[ -]|$)/.exec(message)?.[1];
  if (code) {
    return { success: false, error: `SMTP ${code}: ${message}`, permanent: code.startsWith("5") };
  }
  return { success: false, error: `SMTP connection error: ${message}`, permanent: false };
}
