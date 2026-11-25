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
 * `version` (additive, optional): the Claros release version when the
 * runtime knows it (CLAROS_VERSION; the Workers deploy CLI sets it). Absent
 * otherwise, so the v0.6 shape is unchanged where it is not set.
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
  app.get("/version", (c) => {
    const body: { commit: string; edition: string; builtAt: string | null; version?: string } = {
      commit: process.env.CLAROS_COMMIT_SHA ?? "unknown",
      edition,
      builtAt: process.env.CLAROS_BUILT_AT ?? null,
    };
    if (process.env.CLAROS_VERSION) body.version = process.env.CLAROS_VERSION;
    return c.json(body);
  });
  return app;
}
