import { describe, expect, it } from "vitest";
import { secretLabel, secretState, sinkBody, sinkFormError } from "../src/pages/settings/analytics-sink-form.js";
import type { AnalyticsSink } from "../src/webhooks.js";

const current = (over: Partial<AnalyticsSink> = {}): AnalyticsSink => ({
  sink: "statsraven",
  endpoint: "https://stats.example.com",
  has_secret: true,
  enabled: true,
  updated_at: null,
  ...over,
});

describe("analytics sink form", () => {
  it("names the secret after the sink", () => {
    expect(secretLabel("statsraven")).toBe("Ingest token");
    expect(secretLabel("webhook")).toBe("Signing secret");
    expect(secretState(current())).toBe("Ingest token set");
    expect(secretState(current({ has_secret: false }))).toBe("No ingest token");
    expect(secretState(current({ sink: "webhook" }))).toBe("Signed");
    expect(secretState(current({ sink: "webhook", has_secret: false }))).toBe("Not signed");
  });

  it("leaves an empty secret out, so the stored one is kept", () => {
    expect(sinkBody({ sink: "webhook", endpoint: " https://hooks.example.com/e ", secret: "  " }, current())).toEqual({
      sink: "webhook",
      endpoint: "https://hooks.example.com/e",
    });
    expect(sinkBody({ sink: "statsraven", endpoint: "https://stats.example.com", secret: "sr-token-123" }, null)).toEqual({
      sink: "statsraven",
      endpoint: "https://stats.example.com",
      secret: "sr-token-123",
    });
  });

  it("sends back a site_key the form does not show", () => {
    expect(sinkBody({ sink: "statsraven", endpoint: "https://stats.example.com", secret: "" }, current({ site_key: "acme" }))).toEqual({
      sink: "statsraven",
      endpoint: "https://stats.example.com",
      site_key: "acme",
    });
  });

  it("catches what the server would refuse", () => {
    expect(sinkFormError({ sink: "statsraven", endpoint: "stats.example.com", secret: "" })).toMatch(/http\(s\) URL/);
    expect(sinkFormError({ sink: "statsraven", endpoint: "ftp://stats.example.com", secret: "" })).toMatch(/http\(s\) URL/);
    expect(sinkFormError({ sink: "statsraven", endpoint: "https://stats.example.com", secret: "short" })).toBe("The ingest token is 8 to 500 characters.");
    expect(sinkFormError({ sink: "webhook", endpoint: "http://localhost:8080/e", secret: "" })).toBeNull();
  });
});
