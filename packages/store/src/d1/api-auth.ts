/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-auth.ts.
 *
 * - findActiveTransportConfig: config is the stored JSON text (see
 *   ./transport-text.ts).
 * - findUserByEmail: active users first, then oldest, NULL created_at last
 *   (Postgres ASC order).
 * - consumeMagicLinkToken: CAS UPDATE ... WHERE consumed_at IS NULL
 *   RETURNING, one statement, atomic on SQLite.
 */
import { eq, and, isNull, sql } from "drizzle-orm";
import { users, sessions, magicLinkTokens, transportConfigs, tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiAuthQueries } from "../areas/api-auth.js";
import { findActiveTransportText } from "./transport-text.js";

export function d1ApiAuth(db: D1Db): ApiAuthQueries {
  return {
    async findActiveTransportConfig(tenantId) {
      return findActiveTransportText(db, tenantId);
    },

    async findUserByEmail(email) {
      const rows = await db
        .select({ id: users.id, tenantId: users.tenantId, email: users.email })
        .from(users)
        .where(eq(users.email, email))
        .orderBy(sql`${users.deactivatedAt} IS NOT NULL`, sql`${users.createdAt} IS NULL`, users.createdAt)
        .limit(1);
      return rows[0] ?? null;
    },

    async createMagicLinkToken({ tenantId, userId, tokenHash, expiresAt }) {
      await db.insert(magicLinkTokens).values({ tenantId, userId, tokenHash, expiresAt });
    },

    async hasActiveTransport(tenantId) {
      const rows = await db
        .select({ id: transportConfigs.id })
        .from(transportConfigs)
        .where(and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)))
        .limit(1);
      return rows.length > 0;
    },

    async findTenantBrand(tenantId) {
      const rows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0] ?? null;
    },

    async findMagicLinkToken(tokenHash) {
      const rows = await db
        .select({
          expiresAt: magicLinkTokens.expiresAt,
          consumedAt: magicLinkTokens.consumedAt,
          email: users.email,
        })
        .from(magicLinkTokens)
        .innerJoin(users, eq(users.id, magicLinkTokens.userId))
        .where(eq(magicLinkTokens.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    },

    async consumeMagicLinkToken({ tokenHash, now }) {
      const consumed = await db
        .update(magicLinkTokens)
        .set({ consumedAt: now })
        .where(and(eq(magicLinkTokens.tokenHash, tokenHash), isNull(magicLinkTokens.consumedAt)))
        .returning({
          id: magicLinkTokens.id,
          userId: magicLinkTokens.userId,
          tenantId: magicLinkTokens.tenantId,
          expiresAt: magicLinkTokens.expiresAt,
        });
      return consumed[0] ?? null;
    },

    async createSession({ tenantId, userId, expiresAt }) {
      const rows = await db
        .insert(sessions)
        .values({ tenantId, userId, expiresAt })
        .returning({ id: sessions.id });
      return rows[0]!.id;
    },

    async touchUserLastLogin({ userId, now }) {
      await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
    },

    async deleteSession(sessionId) {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    },

    async findSession(sessionId) {
      const rows = await db
        .select({ userId: sessions.userId, tenantId: sessions.tenantId, expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return rows[0] ?? null;
    },

    async findUserById(userId) {
      const rows = await db
        .select({ id: users.id, email: users.email, name: users.name, role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
