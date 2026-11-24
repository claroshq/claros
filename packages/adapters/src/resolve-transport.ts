/**
 * Shared transport adapter resolution - decrypts credentials and constructs
 * the appropriate TransportAdapter from a provider name and encrypted config.
 *
 * This is the single source of truth for "encrypted config string -> adapter."
 * Both the drain worker (packages/worker) and the auth route (packages/api)
 * call this after querying transport_configs themselves.
 *
 * The function is pure with respect to the database: callers provide the
 * already-read row data. The only environment read is ENCRYPTION_KEY (or an
 * explicit override).
 *
 * Behavior by provider:
 *   - "resend": decrypts, constructs ResendTransportAdapter, returns it.
 *   - "smtp": decrypts, constructs SmtpTransportAdapter, returns it.
 *   - anything else: returns null (unimplemented).
 *
 * Failure modes (all return null):
 *   - ENCRYPTION_KEY missing or invalid
 *   - Decryption failure (wrong key, corrupted envelope)
 *   - JSON parse failure on decrypted content
 */
import { decrypt, parseEncryptionKey } from "./crypto.js";
import { ResendTransportAdapter } from "./resend.js";
import { SmtpTransportAdapter, type SmtpAdapterConfig } from "./smtp.js";
import type { TransportAdapter } from "./transport-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of successful adapter resolution. */
export interface ResolvedTransport {
  /** The constructed adapter, ready to call send(). */
  adapter: TransportAdapter;
  /** The provider name (e.g. "resend"). */
  provider: string;
}

/** Reason why resolution failed. */
export type TransportResolutionFailure =
  | { reason: "no_encryption_key" }
  | { reason: "decryption_failed"; error: string }
  | { reason: "unsupported_provider"; provider: string };

/** Full result type. */
export type ResolveTransportResult =
  | { ok: true; transport: ResolvedTransport }
  | { ok: false; failure: TransportResolutionFailure };

// ---------------------------------------------------------------------------
// resolveTransportAdapter
// ---------------------------------------------------------------------------

/**
 * Decrypt credentials and construct a TransportAdapter for the given provider.
 *
 * @param provider - The provider name from transport_configs.provider.
 * @param encryptedConfig - The encrypted config string from transport_configs.config.
 * @param encryptionKeyOverride - Explicit key (for testing). If omitted, reads ENCRYPTION_KEY from env.
 */
export function resolveTransportAdapter(
  provider: string,
  encryptedConfig: string,
  encryptionKeyOverride?: string,
): ResolveTransportResult {
  // Gate: only resend and smtp are implemented.
  if (provider !== "resend" && provider !== "smtp") {
    return { ok: false, failure: { reason: "unsupported_provider", provider } };
  }

  // Resolve encryption key.
  const encryptionKeyEnv = encryptionKeyOverride ?? process.env.ENCRYPTION_KEY;
  if (!encryptionKeyEnv) {
    return { ok: false, failure: { reason: "no_encryption_key" } };
  }

  // Decrypt and parse.
  let adapter: TransportAdapter;
  try {
    const key = parseEncryptionKey(encryptionKeyEnv);
    const decrypted = decrypt(encryptedConfig, key);
    const parsed = JSON.parse(decrypted) as Record<string, unknown>;

    if (provider === "resend") {
      const apiKey = parsed.apiKey as string;
      adapter = new ResendTransportAdapter({ apiKey });
    } else {
      // provider === "smtp"
      const smtpConfig: SmtpAdapterConfig = {
        host: parsed.host as string,
        port: parsed.port as number,
        secure: parsed.secure as boolean,
        username: (parsed.username as string) || undefined,
        password: (parsed.password as string) || undefined,
        rejectUnauthorized: parsed.rejectUnauthorized as boolean | undefined,
      };
      adapter = new SmtpTransportAdapter(smtpConfig);
    }
  } catch (err) {
    return {
      ok: false,
      failure: {
        reason: "decryption_failed",
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }

  return { ok: true, transport: { adapter, provider } };
}
