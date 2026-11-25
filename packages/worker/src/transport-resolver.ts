/**
 * Transport resolver - reads a tenant's active transports and routing and
 * delegates credential decryption + adapter construction to the shared
 * resolveTransportAdapter() in @claros/adapters.
 *
 * Called per drain tick per tenant and route. No caching - per the recorded
 * [impl] decision: "Transport configuration is read and decrypted per drain
 * tick. No caching."
 *
 * Routing (G26, selectTransport in @claros/core):
 *   - route 'default': tenants.settings.transport_routing.default when it
 *     names an active transport, else the oldest active transport (the only
 *     one on a product that never configured several, as before).
 *   - route 'transactional': transport_routing.transactional when active,
 *     else the default.
 *
 * Behavior by case:
 *   - No active transport: returns null. The drain skips this tenant's
 *     messages without any write (the normal state on a fresh install).
 *   - resend / smtp / cloudflare: decrypts the config and returns the
 *     adapter with its transport_configs row in `transportInfo`.
 *   - ENCRYPTION_KEY missing or invalid, decryption failure, or an
 *     unsupported kind: returns null with a logged operator error.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { resolveTransportAdapter } from "@claros/adapters";
import { selectTransport } from "@claros/core";
import { storeFor } from "@claros/store";
import type { TenantTransportAdapter, TransportResolver, TransportRoute } from "./transport.js";

type Db = NodePgDatabase<Record<string, never>>;

/**
 * Constructs a TransportResolver that reads tenant transport configuration
 * and uses the shared resolveTransportAdapter() for credential handling.
 */
export function buildTenantTransportResolver(db: Db): TransportResolver {
  return async (tenantId: string, route: TransportRoute = "default"): Promise<TenantTransportAdapter | null> => {
    const store = storeFor(db).workerTransportResolver;
    const active = await store.listActiveTransports(tenantId);
    if (active.length === 0) return null;
    const routing = active.length > 1 ? await store.getTransportRouting(tenantId) : {};
    const row = selectTransport(active, routing, route);
    if (row === null) return null;

    const result = resolveTransportAdapter(row.kind, row.config);

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
            `Supported providers: resend, smtp, cloudflare.`,
        );
      }
      return null;
    }

    // A fresh adapter per call: attaching the row keeps its class (and methods).
    return Object.assign(result.transport.adapter, {
      transportInfo: {
        id: row.id,
        kind: row.kind,
        fromEmail: row.from_email,
        fromName: row.from_name,
        replyTo: row.reply_to,
        dailyLimit: row.daily_limit,
      },
    }) as TenantTransportAdapter;
  };
}
