/**
 * @claros/adapters - I/O adapters (database, transport, external services).
 * Depends on @claros/core.
 */
export const CLAROS_ADAPTERS_VERSION = "0.0.0";

export {
  encrypt,
  decrypt,
  parseEncryptionKey,
  type EncryptedEnvelope,
} from "./crypto.js";

export {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  type UnsubscribeTokenPayload,
  type UnsubscribeTokenError,
} from "./unsubscribe-token.js";

export type {
  TransportAdapter,
  TransportSendParams,
  TransportSendResult,
} from "./transport-types.js";

export {
  ResendTransportAdapter,
  type ResendAdapterConfig,
} from "./resend.js";

export {
  SmtpTransportAdapter,
  type SmtpAdapterConfig,
} from "./smtp.js";

export {
  CloudflareTransportAdapter,
  type CloudflareAdapterConfig,
  type CloudflareSendEmailBinding,
} from "./cloudflare.js";

export {
  setTransportRuntime,
  transportRuntime,
  type TransportRuntime,
} from "./transport-runtime.js";

export {
  resolveTransportAdapter,
  SUPPORTED_TRANSPORT_KINDS,
  type ResolvedTransport,
  type TransportResolutionFailure,
  type ResolveTransportResult,
} from "./resolve-transport.js";
