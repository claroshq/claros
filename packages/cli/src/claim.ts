/**
 * First-account claim on Workers. A Worker has no startup step, so the CLI
 * mints the one-time token: it stores the SHA-256 hash (hex) in
 * claim_tokens with `wrangler d1 execute` and prints the URL with the raw
 * token. The Worker's /claim routes check the hash (packages/api,
 * routes/claim.ts hashClaimToken: the same SHA-256 hex).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

/** Same lifetime as the Node server's boot token. */
export const CLAIM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface MintedClaimToken {
  token: string;
  /** SQL for `wrangler d1 execute`: deletes unconsumed tokens, inserts the new hash. */
  sql: string;
}

export function mintClaimToken(now = new Date(), token = randomBytes(32).toString("base64url")): MintedClaimToken {
  const hash = hashClaimToken(token);
  const id = randomUUID();
  // Every value is generated here (hex, uuid, integers): nothing to escape.
  const sql =
    "DELETE FROM claim_tokens WHERE consumed_at IS NULL; " +
    `INSERT INTO claim_tokens (id, token_hash, expires_at, created_at) VALUES ('${id}', '${hash}', ${now.getTime() + CLAIM_TOKEN_TTL_MS}, ${now.getTime()});`;
  return { token, sql };
}

export const ANY_USER_SQL = "SELECT EXISTS (SELECT 1 FROM users) AS any_user";

export function claimUrl(host: string, token: string): string {
  return `https://${host}/claim?token=${token}`;
}
