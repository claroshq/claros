/**
 * Runtime seams for transports. packages/adapters stays runtime-agnostic:
 * the Workers entry (apps/worker) registers what only exists there, the
 * worker-mailer SMTP client and the Cloudflare `send_email` binding. On Node
 * nothing is registered and the defaults apply (nodemailer, REST API).
 */
import type { CloudflareSendEmailBinding } from "./cloudflare.js";
import type { SmtpAdapterConfig } from "./smtp.js";
import type { TransportAdapter } from "./transport-types.js";

export interface TransportRuntime {
  /** SMTP adapter factory; default: nodemailer (SmtpTransportAdapter). */
  smtp?: (config: SmtpAdapterConfig) => TransportAdapter;
  /** Cloudflare Email Service binding (Workers `send_email`, binding EMAIL). */
  cloudflareBinding?: CloudflareSendEmailBinding;
}

let current: TransportRuntime = {};

/** Register the runtime's transport seams (Workers entry; tests). */
export function setTransportRuntime(runtime: TransportRuntime): void {
  current = runtime;
}

export function transportRuntime(): TransportRuntime {
  return current;
}
