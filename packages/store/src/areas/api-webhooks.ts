/**
 * Queries used by packages/api/src/routes/webhooks.ts (the dashboard
 * webhooks page and the /v1/webhooks API).
 *
 * Endpoints are the same webhook_endpoints rows `PUT /v1/config` writes;
 * every write here bumps tenants.config_version in the same atomic unit, so
 * a config apply that read the old state answers 409 instead of overwriting.
 * Implementations: ../pg/api-webhooks.ts and ../d1/api-webhooks.ts.
 */

/** A webhook_endpoints row as the API reads it (the secret only as a flag). */
export interface WebhookEndpointRow {
  id: string;
  tenantId: string;
  slug: string;
  /** webhook | analytics */
  kind: string;
  url: string;
  events: string[];
  config: Record<string, unknown> | null;
  enabled: boolean;
  hasSecret: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** One webhook_outbox row (a delivery). */
export interface EndpointDeliveryRow {
  id: string;
  event: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  payload: unknown;
}

export interface NewWebhookEndpoint {
  tenantId: string;
  slug: string;
  url: string;
  events: string[];
  enabled: boolean;
  config: Record<string, unknown> | null;
  /** Encrypted envelope of the signing secret. */
  secret: string;
  now: Date;
}

/** Fields a PATCH may set; absent keys are left unchanged. */
export interface WebhookEndpointPatch {
  url?: string;
  events?: string[];
  enabled?: boolean;
  config?: Record<string, unknown> | null;
  /** Encrypted envelope (rotation). */
  secret?: string;
}

export interface ApiWebhooksQueries {
  /** The product's endpoints (both kinds), by slug. */
  listEndpoints(tenantId: string): Promise<WebhookEndpointRow[]>;
  /** The product's endpoint with this slug, or null. */
  findEndpoint(input: { tenantId: string; slug: string }): Promise<WebhookEndpointRow | null>;
  /** Insert an endpoint (kind webhook); null when the slug is taken (nothing written). */
  createEndpoint(input: NewWebhookEndpoint): Promise<WebhookEndpointRow | null>;
  /** Update an endpoint of kind webhook; null when there is none with this slug. */
  updateEndpoint(input: { tenantId: string; slug: string; patch: WebhookEndpointPatch; now: Date }): Promise<WebhookEndpointRow | null>;
  /** Delete an endpoint of kind webhook and its pending deliveries; false when there is none. */
  deleteEndpoint(input: { tenantId: string; slug: string; now: Date }): Promise<boolean>;
  /** The endpoint's latest deliveries, newest first. */
  listDeliveries(input: { tenantId: string; endpointId: string; limit: number }): Promise<EndpointDeliveryRow[]>;
}
