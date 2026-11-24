import { describe, it, expect } from "vitest";
import { buildApp } from "@claros/api";

describe("@claros/server", () => {
  it("valid roles are defined", () => {
    const validRoles = ["all", "api", "worker", "scheduler"];
    expect(validRoles).toContain("all");
    expect(validRoles.length).toBe(4);
  });

  // Shutdown-path invariant: app.close() must not hang on an open keep-alive
  // connection. The shutdown sequence in apps/server/src/main.ts calls
  // app.close() first; a persistent client connection (a reverse proxy, a
  // keep-warm ping) would otherwise hold it open until the remote end closes
  // it. close() destroys all connections, so it returns promptly.
  it("app.close() returns promptly with an open keep-alive connection (shutdown guard)", async () => {
    const http = await import("node:http");
    const app = await buildApp({ logger: false });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      http
        .get(`${address}/health`, { agent }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        })
        .on("error", reject);
    });
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(1000);
    agent.destroy();
  });
});
