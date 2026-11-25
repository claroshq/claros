/**
 * Transport adapter interface - the seam between the drain worker and email delivery.
 *
 * Type definitions live in @claros/adapters/transport-types so adapter
 * implementations can reside in packages/adapters without a circular import
 * through packages/worker. This file re-exports those types so existing
 * imports from packages/worker remain unchanged.
 *
 * The LogTransportAdapter (for tests only) lives in packages/worker/tests/.
 * It is structurally impossible to use in production: it is never registered
 * in any resolver, and cannot be imported from src/ without violating the
 * test/src boundary.
 */

// Re-export all transport types from @claros/adapters so callers that import
// from @claros/worker continue to work unchanged.
export type {
  TransportSendResult,
  TransportSendParams,
  TransportAdapter,
} from "@claros/adapters";

// ---------------------------------------------------------------------------
// Resolver type
// ---------------------------------------------------------------------------

import type { TransportAdapter } from "@claros/adapters";
import type { TransportRoute } from "@claros/core";

export type { TransportRoute } from "@claros/core";

/** The transport_configs row behind a resolved adapter. */
export interface TransportInfo {
  id: string;
  /** resend | smtp | cloudflare */
  kind: string;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  dailyLimit: number | null;
}

/**
 * An adapter resolved for a tenant. `transportInfo` is set by the database
 * resolver; adapters handed in by tests may omit it (the drain then reads
 * the sender and daily limit of the tenant's active transport as before).
 */
export interface TenantTransportAdapter extends TransportAdapter {
  readonly transportInfo?: TransportInfo;
}

/**
 * Resolves a TransportAdapter for a given tenant and route ('default' when
 * omitted). Returns null if the tenant has no active transport configured
 * (the message stays approved and is retried next tick).
 */
export type TransportResolver = (tenantId: string, route?: TransportRoute) => Promise<TenantTransportAdapter | null>;

// ---------------------------------------------------------------------------
// Null resolver (fallback when no transport is configured)
// ---------------------------------------------------------------------------

/**
 * A resolver that always returns null.
 * Used as a fallback: when no transport is configured for a tenant, the drain
 * skips its messages without any write. Nothing is sent, nothing is written.
 */
export const nullTransportResolver: TransportResolver = async () => null;
