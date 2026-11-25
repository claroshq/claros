/**
 * Transport resolver - reads a tenant's active transport configuration and
 * delegates credential decryption + adapter construction to the shared
 * resolveTransportAdapter() in @claros/adapters.
 *
 * Called once per drain tick per tenant. No caching - per the recorded
 * [impl] decision: "Transport configuration is read and decrypted per drain
 * tick. No caching." This is a correctness tradeoff; the deferred cache
 * design is in BACKLOG.md "transport resolver caching".
 *
 * Behavior by case:
 *
 *   - Tenant has no active transport_configs row:
 *       Returns null. The drain skips this tenant's messages without any write.
 *       This is the normal state on a fresh install before transport is
 *       configured. Nothing is sent, nothing is written.
 *
 *   - Tenant has an active row for provider = 'resend':
 *       Decrypts the config, reads the API key, constructs and returns a
 *       ResendTransportAdapter.
 *
 *   - Tenant has an active row for provider = 'smtp':
 *       Decrypts the config, reads host/port/credentials, constructs and
 *       returns a SmtpTransportAdapter.
 *
 *   - ENCRYPTION_KEY is missing or invalid:
 *       Returns null with a logged operator error. Same safe fallback.
 *
 *   - Decryption fails (wrong key, corrupted envelope):
 *       Returns null with a logged operator error. Same safe fallback.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { resolveTransportAdapter } from "@claros/adapters";
import { storeFor } from "@claros/store";
import type { TransportAdapter, TransportResolver } from "./transport.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, never>>;

// ---------------------------------------------------------------------------
// buildTenantTransportResolver
// ---------------------------------------------------------------------------

/**
 * Constructs a TransportResolver that reads tenant transport configuration
 * and uses the shared resolveTransportAdapter() for credential handling.
 *
 * @param db - Drizzle database instance.
 * @returns A TransportResolver function.
 */
export function buildTenantTransportResolver(db: Db): TransportResolver {
  return async (tenantId: string): Promise<TransportAdapter | null> => {
    // Step 1: Read the active transport config for this tenant.
    const row = await storeFor(db).workerTransportResolver.getActiveTransportConfig(tenantId);

    if (row === null) {
      // No active transport configured. Messages stay at 'approved'.
      return null;
    }

    // Step 2: Resolve adapter via the shared function in @claros/adapters.
    const result = resolveTransportAdapter(row.provider, row.config);

    if (!result.ok) {
      const { failure } = result;
      if (failure.reason === "no_encryption_key") {
        console.error(
          `[transport-resolver] ENCRYPTION_KEY is not set. ` +
            `Cannot decrypt transport config for tenant ${tenantId}. ` +
            `Messages will remain at 'approved' until the key is configured.`,
        );
      } else if (failure.reason === "decryption_failed") {
        console.error(
          `[transport-resolver] Failed to decrypt transport config for tenant ${tenantId}: ` +
            `${failure.error}. Messages will remain at 'approved'.`,
        );
      } else if (failure.reason === "unsupported_provider") {
        console.warn(
          `[transport-resolver] Provider '${failure.provider}' is not supported. ` +
            `Tenant ${tenantId} messages will remain at 'approved'. ` +
            `Supported providers: resend, smtp.`,
        );
      }
      return null;
    }

    return result.transport.adapter;
  };
}
