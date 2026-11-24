/**
 * Health check route.
 *
 * Registered at root scope (no auth required). Always returns 200
 * regardless of role or edition. This is the compose smoke-test target.
 */
import type { FastifyPluginAsync } from "fastify";

interface HealthRouteOptions {
  role: string;
  edition: string;
}

const healthRoute: FastifyPluginAsync<HealthRouteOptions> = async (app, opts) => {
  const { role, edition } = opts;

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              role: { type: "string" },
              edition: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({ status: "ok", role, edition }),
  );
};

export default healthRoute;
