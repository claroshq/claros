/**
 * Transport seams on Workers (registered with setTransportRuntime):
 *
 *   - SMTP through worker-mailer (TCP sockets via cloudflare:sockets);
 *     nodemailer needs Node's net/tls and does not run here.
 *   - Cloudflare Email Service through the `send_email` binding EMAIL when the
 *     Worker has one (wrangler: "send_email": [{ "name": "EMAIL" }]); without
 *     it the cloudflare transport uses the REST API with its stored token.
 */
import { WorkerMailer } from "worker-mailer";
import {
  setTransportRuntime,
  type CloudflareSendEmailBinding,
  type SmtpAdapterConfig,
  type TransportAdapter,
  type TransportSendParams,
  type TransportSendResult,
} from "@claros/adapters";
import type { Env } from "./bindings.js";
import { classifySmtpError } from "./smtp-errors.js";

const SMTP_TIMEOUT_MS = 30_000;

/** SMTP adapter on worker-mailer. One connection per message, closed after. */
export class WorkerMailerSmtpAdapter implements TransportAdapter {
  constructor(private readonly config: SmtpAdapterConfig) {}

  async send(params: TransportSendParams): Promise<TransportSendResult> {
    try {
      await WorkerMailer.send(
        {
          host: this.config.host,
          port: this.config.port,
          secure: this.config.secure,
          startTls: !this.config.secure,
          credentials: this.config.username
            ? { username: this.config.username, password: this.config.password ?? "" }
            : undefined,
          socketTimeoutMs: SMTP_TIMEOUT_MS,
          responseTimeoutMs: SMTP_TIMEOUT_MS,
        },
        {
          from: params.fromName ? { name: params.fromName, email: params.from } : params.from,
          to: params.to,
          ...(params.replyTo ? { reply: params.replyTo } : {}),
          subject: params.subject,
          html: params.bodyHtml,
          ...(params.bodyText ? { text: params.bodyText } : {}),
          headers: { ...(params.headers ?? {}), "Message-ID": `<${params.messageId}@claros>` },
        },
      );
      // worker-mailer does not expose the server's queue id; our Message-ID is the reference.
      return { success: true, providerMessageId: `${params.messageId}@claros` };
    } catch (err) {
      return classifySmtpError(err);
    }
  }
}

/** Register the Workers transport seams for this invocation's bindings. */
export function syncTransportRuntime(env: Env): void {
  setTransportRuntime({
    smtp: (config) => new WorkerMailerSmtpAdapter(config),
    cloudflareBinding: env.EMAIL as CloudflareSendEmailBinding | undefined,
  });
}
