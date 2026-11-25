/** `claros apply` (G2) against a fake Claros API. */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConfig } from "../src/apply.js";
import { newState, saveState } from "../src/state.js";
import { testEnv } from "./support/context.js";

function file(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "claros-apply-"));
  const path = join(dir, "claros.config.json");
  writeFileSync(path, typeof doc === "string" ? doc : JSON.stringify(doc));
  return path;
}

function withApi(env: ReturnType<typeof testEnv>, status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  env.ctx.fetch = async (url, init) => {
    calls.push({ url, init: init! });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return calls;
}

describe("claros apply", () => {
  it("PUTs the document with the admin key and prints the changes and generated secrets", async () => {
    const env = testEnv();
    const calls = withApi(env, 200, {
      dry_run: false,
      config_version: 4,
      changes: [{ kind: "flow", key: "dunning", action: "update", fields: ["name"] }, { kind: "webhook", key: "app", action: "create" }],
      webhook_secrets: { app: "whsec_x" },
    });
    const code = await applyConfig(env.ctx, { file: file({ flows: [] }), url: "https://claros.example.com/" }, { CLAROS_ADMIN_KEY: "clr_ak_test" });
    expect(code).toBe(0);
    expect(calls[0]!.url).toBe("https://claros.example.com/v1/config");
    expect(calls[0]!.init.method).toBe("PUT");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer clr_ak_test");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ flows: [] });
    expect(env.logs).toEqual([
      "Applied 2 change(s), config version 4:",
      "  update  flow dunning (name)",
      "  create  webhook app",
      "Webhook app signing secret (shown once, store it with the receiver): whsec_x",
    ]);
  });

  it("dry run uses ?dry_run=1; URL from CLAROS_URL or the instance state", async () => {
    const env = testEnv();
    const calls = withApi(env, 200, { dry_run: true, config_version: 1, changes: [] });
    expect(await applyConfig(env.ctx, { file: file({}), dryRun: true }, { CLAROS_ADMIN_KEY: "k", CLAROS_URL: "https://a.example" })).toBe(0);
    expect(calls[0]!.url).toBe("https://a.example/v1/config?dry_run=1");
    expect(env.logs).toEqual(["No changes (config version 1)."]);

    saveState(env.configDir, { ...newState("prod", "acc"), host: "claros.prod.example" });
    expect(await applyConfig(env.ctx, { file: file({}), name: "prod", key: "k" }, {})).toBe(0);
    expect(calls[1]!.url).toBe("https://claros.prod.example/v1/config");
  });

  it("prints validation errors and exits 1; refuses without a file, key or URL", async () => {
    const env = testEnv();
    withApi(env, 400, { error: "The configuration cannot be applied.", errors: ["flows.x: unknown topic 'missing'"] });
    expect(await applyConfig(env.ctx, { file: file({}), url: "https://a.example", key: "k" }, {})).toBe(1);
    expect(env.warnings).toEqual(["400: The configuration cannot be applied."]);
    expect(env.logs).toEqual(["  - flows.x: unknown topic 'missing'"]);
    expect(await applyConfig(env.ctx, {}, {})).toBe(2);
    expect(await applyConfig(env.ctx, { file: file({}) }, { CLAROS_URL: "https://a.example" })).toBe(2);
    expect(await applyConfig(env.ctx, { file: file({}), key: "k" }, {})).toBe(2);
    expect(await applyConfig(env.ctx, { file: file("{not json"), key: "k", url: "https://a.example" }, {})).toBe(2);
  });
});
