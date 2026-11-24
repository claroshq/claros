/**
 * Build provenance route.
 *
 * GET /version - unauthenticated, no database access.
 *
 * Returns the commit SHA the image was built from, the edition, and the image
 * build timestamp. The SHA is injected at image build time via:
 *
 *   docker build --build-arg COMMIT_SHA=<sha> ...
 *
 * which sets CLAROS_COMMIT_SHA in the runner stage ENV. A locally built image
 * without the argument returns "unknown" for commit - this is intentional and
 * never crashes or blocks startup.
 *
 * What is NOT included: hostnames, full env values, secrets, credentials, or
 * any fingerprint. This endpoint is public and must be safe to expose.
 */
import { createRouter } from "../http/router.js";

interface VersionRouteOptions {
  edition: string;
}

export default function versionRoutes(opts: VersionRouteOptions) {
  const { edition } = opts;
  const app = createRouter();
  app.get("/version", (c) =>
    c.json({
      commit: process.env.CLAROS_COMMIT_SHA ?? "unknown",
      edition,
      builtAt: process.env.CLAROS_BUILT_AT ?? null,
    }),
  );
  return app;
}
