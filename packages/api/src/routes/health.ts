/**
 * Health check route.
 *
 * Registered at root scope (no auth required). Always returns 200
 * regardless of role or edition. This is the compose smoke-test target.
 */
import { createRouter } from "../http/router.js";

interface HealthRouteOptions {
  role: string;
  edition: string;
}

export default function healthRoutes(opts: HealthRouteOptions) {
  const { role, edition } = opts;
  const app = createRouter();
  app.get("/health", (c) => c.json({ status: "ok", role, edition }));
  return app;
}
