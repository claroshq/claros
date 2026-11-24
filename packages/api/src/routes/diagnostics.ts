/**
 * Diagnostics route - authenticated deployment health check.
 *
 * GET /v1/diagnostics
 *
 * Behind the /v1 session-cookie preHandler (request.tenant must be non-null).
 * No new auth mechanism - uses the existing session cookie.
 *
 * Returns the container's own view of its environment:
 *   commit    - CLAROS_COMMIT_SHA env (set at image build time via --build-arg)
 *   edition   - always "community" (kept for v0.6 compatibility)
 *   builtAt   - CLAROS_BUILT_AT env (null if absent)
 *   startedAt - ISO-8601 UTC timestamp of when this container process started.
 *               Computed once at module load time from Date.now() and
 *               process.uptime(). Use this to distinguish a slow rollout
 *               (startedAt advances once, then holds) from a container that
 *               restarted mid-window (startedAt resets to a later value).
 *   keys      - for ENCRYPTION_KEY and UNSUBSCRIBE_SIGNING_KEY:
 *                 present (boolean), byteLength (decoded bytes), fingerprint
 *                 (first 8 hex chars of SHA-256 of the decoded bytes)
 *
 * Encoding conventions (must match what claros.mjs localKeyInfo uses):
 *   ENCRYPTION_KEY:         base64-encoded, decoded to 32 bytes
 *   UNSUBSCRIBE_SIGNING_KEY: hex-encoded, decoded to 32 bytes
 *
 * NEVER returns secret values, key material, or connection strings.
 * Fingerprints and decoded byte lengths only.
 *
 * Used by `claros doctor` to compare the container's live environment against
 * the operator's local environment after a secret rotation or deploy.
 */
import type { FastifyPluginAsync } from "fastify";
import { createHash } from "node:crypto";

// Computed once at module load time so every request returns a stable value
// for the lifetime of this process. process.uptime() is the seconds since the
// Node.js process started; subtracting it from the current wall-clock time
// gives the wall-clock start time regardless of when the module is imported.
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

type KeyResult =
  | { present: true;  byteLength: number; fingerprint: string; decodeError: null }
  | { present: true;  byteLength: null;   fingerprint: null;   decodeError: string }
  | { present: false; byteLength: null;   fingerprint: null;   decodeError: null };

/**
 * Decode a key value and return its decoded byte length and the SHA-256
 * fingerprint of the decoded bytes. If decoding fails the error is returned
 * and byteLength/fingerprint are null so the comparison side can label it
 * explicitly rather than silently mismatching.
 */
function decodeAndFingerprint(raw: string, encoding: "base64" | "hex"): KeyResult {
  try {
    const buf = Buffer.from(raw, encoding);
    if (buf.length === 0) {
      return { present: true, byteLength: null, fingerprint: null, decodeError: `decoded to 0 bytes (encoding: ${encoding})` };
    }
    const fp = createHash("sha256").update(buf).digest("hex").slice(0, 8);
    return { present: true, byteLength: buf.length, fingerprint: fp, decodeError: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { present: true, byteLength: null, fingerprint: null, decodeError: msg };
  }
}

function keyAbsent(): KeyResult {
  return { present: false, byteLength: null, fingerprint: null, decodeError: null };
}

const diagnosticsRoute: FastifyPluginAsync = async (app) => {
  app.get(
    "/",
    {
      config: { minRole: "member" as const },
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              commit:  { type: "string" },
              edition: { type: "string" },
              builtAt: { type: ["string", "null"] },
              startedAt: { type: "string" },
              keys: {
                type: "object",
                properties: {
                  ENCRYPTION_KEY: {
                    type: "object",
                    properties: {
                      present:     { type: "boolean" },
                      byteLength:  { type: ["integer", "null"] },
                      fingerprint: { type: ["string", "null"] },
                      decodeError: { type: ["string", "null"] },
                    },
                  },
                  UNSUBSCRIBE_SIGNING_KEY: {
                    type: "object",
                    properties: {
                      present:     { type: "boolean" },
                      byteLength:  { type: ["integer", "null"] },
                      fingerprint: { type: ["string", "null"] },
                      decodeError: { type: ["string", "null"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => {
      const encKey = process.env.ENCRYPTION_KEY;
      const sigKey = process.env.UNSUBSCRIBE_SIGNING_KEY;

      return {
        commit:  process.env.CLAROS_COMMIT_SHA ?? "unknown",
        edition: "community",
        builtAt: process.env.CLAROS_BUILT_AT   ?? null,
        startedAt: PROCESS_STARTED_AT,
        keys: {
          // ENCRYPTION_KEY is base64-encoded (44 chars -> 32 bytes)
          ENCRYPTION_KEY:         encKey ? decodeAndFingerprint(encKey, "base64") : keyAbsent(),
          // UNSUBSCRIBE_SIGNING_KEY is hex-encoded (64 chars -> 32 bytes)
          UNSUBSCRIBE_SIGNING_KEY: sigKey ? decodeAndFingerprint(sigKey, "hex")    : keyAbsent(),
        },
      };
    },
  );
};

export default diagnosticsRoute;
