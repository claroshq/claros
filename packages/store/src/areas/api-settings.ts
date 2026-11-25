/**
 * Queries used by packages/api/src/routes/settings.ts.
 *
 * Every method is one database operation (or one atomic batch) that the
 * caller needs. Implementations: ../pg/api-settings.ts (Postgres) and, later,
 * ../d1/api-settings.ts (SQLite / Cloudflare D1). Methods take and return plain
 * values (Date for timestamps), never Drizzle objects.
 */

/** A transport config as the settings routes display it (no credentials). */
export interface SettingsTransportRow {
  id: string;
  provider: string;
  fromEmail: string;
  fromName: string | null;
  dailyLimit: number | null;
  dkimVerified: boolean | null;
  isActive: boolean | null;
  createdAt: Date | null;
}

/** A transport with its kind, name and reply-to (the multi-transport routes). */
export interface SettingsTransportDetailRow extends SettingsTransportRow {
  /** resend | smtp | cloudflare (provider on rows written before kind existed). */
  kind: string;
  name: string | null;
  replyTo: string | null;
}

/** A transport with its encrypted envelope as JSON text (test sends). */
export interface SettingsTransportWithConfig extends SettingsTransportDetailRow {
  config: string;
}

/** A new transport for the multi-transport routes (inserted active, nothing deactivated). */
export interface NewTransport {
  tenantId: string;
  kind: string;
  name: string | null;
  encryptedConfig: string;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  dailyLimit: number | null;
}

/** Fields a PATCH may set on a transport; absent keys are left unchanged. */
export interface TransportPatch {
  name?: string | null;
  fromEmail?: string;
  fromName?: string | null;
  replyTo?: string | null;
  dailyLimit?: number | null;
  encryptedConfig?: string;
}

export interface NewTransportConfig {
  tenantId: string;
  provider: string;
  /** Encrypted credential envelope (stored as JSON). */
  encryptedConfig: string;
  fromEmail: string;
  fromName: string | null;
  dailyLimit: number | null;
}

/** An LLM config row without its envelope. */
export interface SettingsLlmRow {
  id: string;
  provider: string;
  isActive: boolean | null;
  createdAt: Date | null;
}

/** An LLM config row with its encrypted envelope. */
export interface SettingsLlmRowWithConfig extends SettingsLlmRow {
  config: string;
}

export interface SettingsTenantRow {
  id: string;
  name: string;
  slug: string;
  plan: string | null;
  settings: unknown;
  createdAt: Date | null;
}

/** The active transport as the test-email sender needs it (config as JSON text). */
export interface SettingsSendTransportRow {
  provider: string;
  config: string;
  from_email: string;
  from_name: string | null;
}

export interface ApiSettingsQueries {
  /** Mark every active transport config of the tenant inactive. */
  deactivateActiveTransportConfigs(tenantId: string): Promise<void>;
  /** Insert a new active transport config and return its display row. */
  insertActiveTransportConfig(input: NewTransportConfig): Promise<SettingsTransportRow | undefined>;
  /** The tenant's active transport config (display columns), or null. */
  findActiveTransportConfig(tenantId: string): Promise<SettingsTransportRow | null>;
  /** Mark every active LLM config of the tenant inactive. */
  deactivateActiveLlmConfigs(tenantId: string): Promise<void>;
  /** Insert a new active LLM config with an encrypted envelope and return its row. */
  insertActiveLlmConfig(input: { tenantId: string; provider: string; encryptedConfig: string }): Promise<SettingsLlmRow | undefined>;
  /** The tenant's active LLM config including its encrypted envelope, or null. */
  findActiveLlmConfig(tenantId: string): Promise<SettingsLlmRowWithConfig | null>;
  /** Deactivate every active embedding config of the tenant. */
  deactivateActiveEmbeddingConfigs(tenantId: string): Promise<void>;
  /** Insert a new active embedding config with an encrypted envelope and return its row. */
  insertActiveEmbeddingConfig(input: { tenantId: string; provider: string; encryptedConfig: string }): Promise<SettingsLlmRow | undefined>;
  /** The tenant's active embedding config including its encrypted envelope, or null. */
  findActiveEmbeddingConfig(tenantId: string): Promise<SettingsLlmRowWithConfig | null>;
  /** Tenant metadata and settings, or null. */
  findTenant(tenantId: string): Promise<SettingsTenantRow | null>;
  /** The tenant's settings JSON wrapped in a row, or null when the tenant does not exist. */
  findTenantSettings(tenantId: string): Promise<{ settings: unknown } | null>;
  /** Replace the tenant's settings JSON. */
  updateTenantSettings(tenantId: string, settings: Record<string, unknown>): Promise<void>;
  /** The tenant's name and settings JSON, or null when the tenant does not exist. */
  findTenantNameAndSettings(tenantId: string): Promise<{ name: string; settings: unknown; publicHost: string | null } | null>;
  /** The tenant's active transport with its config as JSON text, or null. */
  findActiveTransportForSend(tenantId: string): Promise<SettingsSendTransportRow | null>;
  /** Every active transport of the tenant, oldest first (created_at, then id). */
  listActiveTransports(tenantId: string): Promise<SettingsTransportDetailRow[]>;
  /** The tenant's active transport by id with its envelope, or null. */
  findActiveTransport(input: { tenantId: string; id: string }): Promise<SettingsTransportWithConfig | null>;
  /** Insert an active transport (other transports stay active) and return it. */
  insertTransport(input: NewTransport): Promise<SettingsTransportDetailRow | undefined>;
  /** Patch the tenant's active transport; null when it does not exist or is inactive. */
  updateTransport(input: { tenantId: string; id: string; patch: TransportPatch }): Promise<SettingsTransportDetailRow | null>;
  /** Mark the tenant's transport inactive (kept for history); true when an active row was changed. */
  deactivateTransport(input: { tenantId: string; id: string }): Promise<boolean>;
}
