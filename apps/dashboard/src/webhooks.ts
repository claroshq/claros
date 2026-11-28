/**
 * Webhook endpoints (Settings > Webhooks) and the config export
 * (Settings > Config as code).
 *
 *   GET/POST /v1/webhooks, PATCH/DELETE /v1/webhooks/:slug,
 *   POST /v1/webhooks/:slug/rotate, GET /v1/webhooks/:slug/deliveries,
 *   GET/PUT/DELETE /v1/analytics-sink, GET /v1/config
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api.js";

export interface WebhookEndpoint {
  id: string;
  slug: string;
  /** webhook | analytics (the analytics sink, read-only here) */
  kind: string;
  url: string;
  events: string[];
  enabled: boolean;
  batch_interval_minutes: number;
  has_secret: boolean;
  read_only: boolean;
  /** statsraven | webhook for the analytics sink; null (or absent on older servers) for a webhook. */
  sink?: AnalyticsSinkKind | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface WebhooksResponse {
  webhooks: WebhookEndpoint[];
  /** Every event an endpoint can subscribe to. */
  events: string[];
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: "pending" | "delivered" | "dead" | string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
  payload: unknown;
}

export interface NewWebhookInput {
  slug: string;
  url: string;
  events: string[];
  enabled?: boolean;
  batch_interval_minutes?: number;
}

export interface WebhookPatch {
  url?: string;
  events?: string[];
  enabled?: boolean;
  batch_interval_minutes?: number | null;
}

export type AnalyticsSinkKind = "statsraven" | "webhook";

/** The product's analytics sink (settings.analytics); the secret is never returned. */
export interface AnalyticsSink {
  sink: AnalyticsSinkKind;
  endpoint: string;
  site_key?: string;
  has_secret: boolean;
  enabled: boolean;
  updated_at: string | null;
}

export interface AnalyticsSinkResponse {
  analytics_sink: AnalyticsSink | null;
  sinks: AnalyticsSinkKind[];
  /** False when the caller may read but not change it (members). */
  editable: boolean;
}

/** PUT /v1/analytics-sink: settings.analytics; secret left out keeps the stored one. */
export interface AnalyticsSinkInput {
  sink: AnalyticsSinkKind;
  endpoint: string;
  site_key?: string;
  secret?: string;
}

/** An error from the webhooks API, with the server's message. */
export class WebhookApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const issues = Array.isArray(body?.issues)
      ? (body!.issues as Array<{ path: string; message: string }>).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")
      : "";
    const msg = issues || (typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
    throw new WebhookApiError(msg, res.status);
  }
  return body as T;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
});

export const fetchWebhooks = async (): Promise<WebhooksResponse> => json(await apiFetch("/v1/webhooks"));
export const createWebhook = async (input: NewWebhookInput): Promise<WebhookEndpoint & { secret: string }> =>
  json(await apiFetch("/v1/webhooks", jsonInit("POST", input)));
export const patchWebhook = async (slug: string, patch: WebhookPatch): Promise<WebhookEndpoint> =>
  json(await apiFetch(`/v1/webhooks/${encodeURIComponent(slug)}`, jsonInit("PATCH", patch)));
export const deleteWebhook = async (slug: string): Promise<void> => {
  await json(await apiFetch(`/v1/webhooks/${encodeURIComponent(slug)}`, jsonInit("DELETE")));
};
export const rotateWebhook = async (slug: string): Promise<WebhookEndpoint & { secret: string }> =>
  json(await apiFetch(`/v1/webhooks/${encodeURIComponent(slug)}/rotate`, jsonInit("POST")));
export const fetchDeliveries = async (slug: string): Promise<{ deliveries: WebhookDelivery[] }> =>
  json(await apiFetch(`/v1/webhooks/${encodeURIComponent(slug)}/deliveries`));

export const fetchAnalyticsSink = async (): Promise<AnalyticsSinkResponse> => json(await apiFetch("/v1/analytics-sink"));
export const putAnalyticsSink = async (input: AnalyticsSinkInput): Promise<AnalyticsSinkResponse> =>
  json(await apiFetch("/v1/analytics-sink", jsonInit("PUT", input)));
export const deleteAnalyticsSink = async (): Promise<void> => {
  await json(await apiFetch("/v1/analytics-sink", jsonInit("DELETE")));
};

/** GET /v1/config: the product's configuration as a config document (no secrets). */
export const fetchConfigDocument = async (): Promise<Record<string, unknown>> => json(await apiFetch("/v1/config"));

export const WEBHOOKS_QUERY_KEY = ["webhooks"] as const;

export function useWebhooks() {
  return useQuery({ queryKey: WEBHOOKS_QUERY_KEY, queryFn: fetchWebhooks });
}

export function useWebhookDeliveries(slug: string | null) {
  return useQuery({
    queryKey: [...WEBHOOKS_QUERY_KEY, "deliveries", slug],
    queryFn: () => fetchDeliveries(slug!),
    enabled: slug !== null,
    refetchInterval: 15_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: WEBHOOKS_QUERY_KEY });
}

export function useCreateWebhook() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: createWebhook, onSuccess: invalidate });
}

export function usePatchWebhook() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: ({ slug, patch }: { slug: string; patch: WebhookPatch }) => patchWebhook(slug, patch), onSuccess: invalidate });
}

export function useDeleteWebhook() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: deleteWebhook, onSuccess: invalidate });
}

export const ANALYTICS_SINK_QUERY_KEY = [...WEBHOOKS_QUERY_KEY, "analytics-sink"] as const;

export function useAnalyticsSink() {
  return useQuery({ queryKey: ANALYTICS_SINK_QUERY_KEY, queryFn: fetchAnalyticsSink });
}

export function usePutAnalyticsSink() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: putAnalyticsSink, onSuccess: invalidate });
}

export function useDeleteAnalyticsSink() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: deleteAnalyticsSink, onSuccess: invalidate });
}

export function useRotateWebhook() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: rotateWebhook, onSuccess: invalidate });
}

/** Download a JSON value as a file in the browser. */
export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
