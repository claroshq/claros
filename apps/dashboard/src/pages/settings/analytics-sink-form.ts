/**
 * The analytics sink form (Settings > Webhooks) without React: labels per
 * sink and the PUT /v1/analytics-sink body, so both are unit tested.
 */
import type { AnalyticsSink, AnalyticsSinkInput, AnalyticsSinkKind } from "../../webhooks.js";

export const SINK_LABELS: Record<AnalyticsSinkKind, string> = {
  statsraven: "StatsRaven",
  webhook: "Webhook",
};

/** The label of the secret field: StatsRaven takes an ingest token, a webhook an optional signing secret. */
export function secretLabel(sink: AnalyticsSinkKind): string {
  return sink === "statsraven" ? "Ingest token" : "Signing secret";
}

/** How the stored secret reads on the configured row. */
export function secretState(sink: AnalyticsSink): string {
  if (sink.sink === "statsraven") return sink.has_secret ? "Ingest token set" : "No ingest token";
  return sink.has_secret ? "Signed" : "Not signed";
}

export interface SinkFormValues {
  sink: AnalyticsSinkKind;
  endpoint: string;
  secret: string;
}

/**
 * The PUT body. An empty secret is left out, so the stored one is kept (as
 * in a config document). The site_key the sink already has is sent back
 * unchanged: the form does not show it, and a PUT replaces the whole sink.
 */
export function sinkBody(form: SinkFormValues, current: AnalyticsSink | null): AnalyticsSinkInput {
  const secret = form.secret.trim();
  return {
    sink: form.sink,
    endpoint: form.endpoint.trim(),
    ...(current?.site_key !== undefined ? { site_key: current.site_key } : {}),
    ...(secret !== "" ? { secret } : {}),
  };
}

/** A message for a form the server would refuse, or null. Mirrors the settings.analytics schema. */
export function sinkFormError(form: SinkFormValues): string | null {
  const endpoint = form.endpoint.trim();
  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return "The address is an http(s) URL, for example https://stats.example.com.";
  const secret = form.secret.trim();
  if (secret !== "" && (secret.length < 8 || secret.length > 500)) return `The ${secretLabel(form.sink).toLowerCase()} is 8 to 500 characters.`;
  return null;
}
