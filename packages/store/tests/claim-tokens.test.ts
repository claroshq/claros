/**
 * Contract tests for the claim token queries (every backend):
 * apiClaim.ensureClaimToken / isClaimTokenValid / consumeClaimToken and
 * serverMain.replaceClaimToken.
 *
 * claim_tokens is instance-wide. replaceClaimToken deletes every unconsumed
 * token, so all claim token tests live in this one file (vitest runs a
 * file's tests in order) and no other store test writes the table.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testBackends, type Backend } from "./support/backends.js";

const HOUR = 60 * 60 * 1000;
const hash = () => `h-${randomUUID()}`;

for (const factory of testBackends()) {
  describe(`claim tokens on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const row = async (tokenHash: string) =>
      (await b.db.select().from(b.schema.claimTokens).where(eq(b.schema.claimTokens.tokenHash, tokenHash)))[0];

    it("ensureClaimToken inserts once; a second call with the same hash is a no-op", async () => {
      const h = hash();
      const now = new Date();
      await b.store.apiClaim.ensureClaimToken({ tokenHash: h, expiresAt: new Date(now.getTime() + HOUR) });
      const first = await row(h);
      expect(first).toMatchObject({ tokenHash: h, consumedAt: null });
      expect(first.expiresAt).toBeInstanceOf(Date);
      expect(first.createdAt).toBeInstanceOf(Date);
      await b.store.apiClaim.ensureClaimToken({ tokenHash: h, expiresAt: new Date(now.getTime() + 2 * HOUR) });
      const all = await b.db.select().from(b.schema.claimTokens).where(eq(b.schema.claimTokens.tokenHash, h));
      expect(all).toHaveLength(1);
      expect(all[0].expiresAt.getTime()).toBe(first.expiresAt.getTime());
    });

    it("isClaimTokenValid: unknown, expired and consumed tokens are invalid", async () => {
      const now = new Date();
      const live = hash();
      const expired = hash();
      await b.store.apiClaim.ensureClaimToken({ tokenHash: live, expiresAt: new Date(now.getTime() + HOUR) });
      await b.store.apiClaim.ensureClaimToken({ tokenHash: expired, expiresAt: new Date(now.getTime() - 1) });
      expect(await b.store.apiClaim.isClaimTokenValid({ tokenHash: live, now })).toBe(true);
      expect(await b.store.apiClaim.isClaimTokenValid({ tokenHash: expired, now })).toBe(false);
      expect(await b.store.apiClaim.isClaimTokenValid({ tokenHash: hash(), now })).toBe(false);
      expect(await b.store.apiClaim.consumeClaimToken({ tokenHash: live, now })).toBe(true);
      expect(await b.store.apiClaim.isClaimTokenValid({ tokenHash: live, now })).toBe(false);
      expect((await row(live)).consumedAt.getTime()).toBe(now.getTime());
    });

    it("consumeClaimToken refuses expired and unknown tokens", async () => {
      const now = new Date();
      const expired = hash();
      await b.store.apiClaim.ensureClaimToken({ tokenHash: expired, expiresAt: new Date(now.getTime() - 1) });
      expect(await b.store.apiClaim.consumeClaimToken({ tokenHash: expired, now })).toBe(false);
      expect((await row(expired)).consumedAt).toBeNull();
      expect(await b.store.apiClaim.consumeClaimToken({ tokenHash: hash(), now })).toBe(false);
    });

    it("consumeClaimToken: concurrent consumers, exactly one wins", async () => {
      const now = new Date();
      const h = hash();
      await b.store.apiClaim.ensureClaimToken({ tokenHash: h, expiresAt: new Date(now.getTime() + HOUR) });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => b.store.apiClaim.consumeClaimToken({ tokenHash: h, now })),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("replaceClaimToken deletes unconsumed tokens, keeps consumed ones, inserts the new one", async () => {
      const now = new Date();
      const old = hash();
      const used = hash();
      await b.store.apiClaim.ensureClaimToken({ tokenHash: old, expiresAt: new Date(now.getTime() + HOUR) });
      await b.store.apiClaim.ensureClaimToken({ tokenHash: used, expiresAt: new Date(now.getTime() + HOUR) });
      expect(await b.store.apiClaim.consumeClaimToken({ tokenHash: used, now })).toBe(true);

      const fresh = hash();
      await b.store.serverMain.replaceClaimToken({ tokenHash: fresh, expiresAt: new Date(now.getTime() + 24 * HOUR) });
      expect(await row(old)).toBeUndefined();
      expect(await row(used)).toMatchObject({ tokenHash: used });
      expect(await b.store.apiClaim.isClaimTokenValid({ tokenHash: fresh, now })).toBe(true);
      const unconsumed = (await b.db.select().from(b.schema.claimTokens)).filter(
        (r: { consumedAt: Date | null }) => r.consumedAt === null,
      );
      expect(unconsumed.map((r: { tokenHash: string }) => r.tokenHash)).toEqual([fresh]);

      // A second boot replaces it again.
      const next = hash();
      await b.store.serverMain.replaceClaimToken({ tokenHash: next, expiresAt: new Date(now.getTime() + 24 * HOUR) });
      expect(await b.store.apiClaim.isClaimTokenValid({ tokenHash: fresh, now })).toBe(false);
      expect(await b.store.apiClaim.isClaimTokenValid({ tokenHash: next, now })).toBe(true);
    });
  });
}
