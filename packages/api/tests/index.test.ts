import { describe, it, expect } from "vitest";
import { buildApp } from "../src/index.js";

describe("buildApp", () => {
  it("starts and /health returns 200 with correct shape", async () => {
    const app = await buildApp({ logger: false, role: "all", edition: "community" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; role: string; edition: string };
    expect(body.status).toBe("ok");
    expect(body.role).toBe("all");
    expect(body.edition).toBe("community");
    await app.close();
  });

  it("/health reflects the role and edition passed as options", async () => {
    const app = await buildApp({ logger: false, role: "api", edition: "cloud" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; role: string; edition: string };
    expect(body.role).toBe("api");
    expect(body.edition).toBe("cloud");
    await app.close();
  });

  it("/health is not under /v1 (public route, no auth required)", async () => {
    const app = await buildApp({ logger: false });
    const v1health = await app.inject({ method: "GET", url: "/v1/health" });
    // Without a db no dashboard routes are registered, so /v1/health is a 404.
    // Once routes are added (task 7+), the /v1 preHandler will enforce auth (401).
    expect(v1health.statusCode).toBe(404);
    await app.close();
  });

  it("request.tenant is decorated (null by default)", async () => {
    const app = await buildApp({ logger: false });
    let capturedTenant: unknown = "NOT_SET";
    app.hono.get("/test-tenant", (c) => {
      capturedTenant = c.var.tenant;
      return c.json({ ok: true });
    });
    await app.inject({ method: "GET", url: "/test-tenant" });
    expect(capturedTenant).toBeNull();
    await app.close();
  });
});
