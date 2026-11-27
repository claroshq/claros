import { describe, expect, it } from "vitest";
import { mcpKeyState, mcpKeys } from "../src/pages/connect-ai/mcp.js";
import { ago } from "../src/lib/time.js";
import type { IngestKey } from "../src/api.js";

function key(over: Partial<IngestKey>): IngestKey {
  return {
    id: "k",
    kind: "admin",
    prefix: "clr_ak_x",
    label: null,
    allowed_origins: [],
    scopes: ["messages"],
    last_used_at: null,
    created_at: null,
    revoked_at: null,
    ...over,
  };
}

describe("mcpKeyState", () => {
  it("is none without a live admin key that has the messages scope", () => {
    expect(mcpKeyState([])).toEqual({ kind: "none" });
    expect(mcpKeyState([key({ kind: "secret" })]).kind).toBe("none");
    expect(mcpKeyState([key({ scopes: ["config"] })]).kind).toBe("none");
    expect(mcpKeyState([key({ revoked_at: "2026-11-01T00:00:00Z" })]).kind).toBe("none");
  });

  it("is ready when a usable key was never used", () => {
    expect(mcpKeyState([key({})]).kind).toBe("ready");
  });

  it("reports the latest use across usable keys only", () => {
    const keys = [
      key({ id: "a", last_used_at: "2026-11-20T10:00:00Z" }),
      key({ id: "b", last_used_at: "2026-11-25T10:00:00Z" }),
      key({ id: "c", scopes: ["config"], last_used_at: "2026-11-27T10:00:00Z" }),
    ];
    expect(mcpKeys(keys).map((k) => k.id)).toEqual(["a", "b"]);
    expect(mcpKeyState(keys)).toMatchObject({ kind: "used", lastUsedAt: "2026-11-25T10:00:00Z" });
  });
});

describe("ago", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  it("reads as relative time, then the date after a week", () => {
    expect(ago(null, now)).toBe("never");
    expect(ago("2026-11-27T11:59:40Z", now)).toBe("just now");
    expect(ago("2026-11-27T11:48:00Z", now)).toBe("12m ago");
    expect(ago("2026-11-27T09:00:00Z", now)).toBe("3h ago");
    expect(ago("2026-11-26T11:00:00Z", now)).toBe("yesterday");
    expect(ago("2026-11-23T12:00:00Z", now)).toBe("4d ago");
    expect(ago("2026-11-10T12:00:00Z", now)).toBe("Nov 10");
  });
});
