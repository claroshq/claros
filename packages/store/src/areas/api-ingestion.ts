/**
 * Queries used by packages/api/src/routes/ingestion.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-ingestion.ts (Postgres) and, later,
 * ../d1/api-ingestion.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** An API key as the management routes display it (never the hash). */
export interface IngestionKeyRow {
  id: string;
  kind: string;
  prefix: string;
  label: string | null;
  allowedOrigins: string[] | null;
  /** Admin keys: granted scopes; null for other kinds. */
  scopes: string[] | null;
  lastUsedAt: Date | null;
  createdAt: Date | null;
  revokedAt: Date | null;
}

export interface NewIngestionKey {
  tenantId: string;
  keyHash: string;
  prefix: string;
  label: string | null;
  kind: string;
  allowedOrigins: string[] | null;
  /** Admin keys only. */
  scopes?: string[] | null;
}

export interface IngestionKeyUpdates {
  label?: string | null;
  allowedOrigins?: string[] | undefined;
  scopes?: string[] | undefined;
}

/** The most recent event with its contact's external id. */
export interface LastIngestedEventRow {
  type: string;
  eventName: string | null;
  receivedAt: Date;
  externalId: string;
}

export interface ApiIngestionQueries {
  /** All keys of a tenant, active and revoked, oldest first. */
  listKeys(tenantId: string): Promise<IngestionKeyRow[]>;
  /** Insert a key and return its display row. */
  createKey(key: NewIngestionKey): Promise<IngestionKeyRow | undefined>;
  /** id + kind of a tenant's key, or null when it does not exist in that tenant. */
  findKeyKind(tenantId: string, keyId: string): Promise<{ id: string; kind: string } | null>;
  /** Apply label / allowed_origins updates to a key (by id) and return its display row. */
  updateKey(keyId: string, updates: IngestionKeyUpdates): Promise<IngestionKeyRow | undefined>;
  /** id + revoked_at of a tenant's key, or null when it does not exist in that tenant. */
  findKeyRevocation(tenantId: string, keyId: string): Promise<{ id: string; revokedAt: Date | null } | null>;
  /** Set revoked_at on a key (by id). */
  revokeKey(keyId: string, at: Date): Promise<void>;
  /** The tenant's most recent event received at or after `since` (joined to its contact), or null. */
  findLastEventSince(tenantId: string, since: Date): Promise<LastIngestedEventRow | null>;
  /** Number of the tenant's events received at or after `since`. */
  countEventsSince(tenantId: string, since: Date): Promise<number | undefined>;
}
