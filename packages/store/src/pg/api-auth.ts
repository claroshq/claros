/**
 * Postgres implementation of the queries used by packages/api/src/routes/auth.ts.
 */
import { eq, and, isNull, sql } from "drizzle-orm";
import {
  users,
  sessions,
  magicLinkTokens,
  transportConfigs,
  tenants,
} from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiAuthQueries } from "../areas/api-auth.js";

export function pgApiAuth(db: PgDb): ApiAuthQueries {
  return {
    async findActiveTransportConfig(tenantId) {
      // Read active transport config
      const rows = await db.execute<{
        provider: string;
        config: string;
        from_email: string;
        from_name: string | null;
      }>(sql`
        SELECT provider, config::text AS config, from_email, from_name
        FROM transport_configs
        WHERE tenant_id = ${tenantId}::uuid
          AND is_active = true
        LIMIT 1
      `);
      return rows.rows[0] ?? null;
    },

    async findUserByEmail(email) {
      // Look up user by email (across all tenants for login - user belongs to exactly one tenant)
      const userRows = await db
        .select({
          id: users.id,
          tenantId: users.tenantId,
          email: users.email,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return userRows[0] ?? null;
    },

    async createMagicLinkToken({ tenantId, userId, tokenHash, expiresAt }) {
      await db.insert(magicLinkTokens).values({
        tenantId,
        userId,
        tokenHash,
        expiresAt,
      });
    },

    async hasActiveTransport(tenantId) {
      const transports = await db
        .select({ id: transportConfigs.id })
        .from(transportConfigs)
        .where(
          and(
            eq(transportConfigs.tenantId, tenantId),
            eq(transportConfigs.isActive, true),
          ),
        )
        .limit(1);
      return transports.length > 0;
    },

    async findTenantBrand(tenantId) {
      const tenantRows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return tenantRows[0] ?? null;
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
      // Atomic CAS: consume the token only if it has not been consumed yet.
      // This ensures single-use even under concurrent requests.
      const consumed = await db
        .update(magicLinkTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(magicLinkTokens.tokenHash, tokenHash),
            isNull(magicLinkTokens.consumedAt),
          ),
        )
        .returning({
          id: magicLinkTokens.id,
          userId: magicLinkTokens.userId,
          tenantId: magicLinkTokens.tenantId,
          expiresAt: magicLinkTokens.expiresAt,
        });
      return consumed[0] ?? null;
    },

    async createSession({ tenantId, userId, expiresAt }) {
      const sessionRows = await db
        .insert(sessions)
        .values({
          tenantId,
          userId,
          expiresAt,
        })
        .returning({ id: sessions.id });
      return sessionRows[0]!.id;
    },

    async touchUserLastLogin({ userId, now }) {
      await db
        .update(users)
        .set({ lastLoginAt: now })
        .where(eq(users.id, userId));
    },

    async deleteSession(sessionId) {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    },

    async findSession(sessionId) {
      const sessionRows = await db
        .select({
          userId: sessions.userId,
          tenantId: sessions.tenantId,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return sessionRows[0] ?? null;
    },

    async findUserById(userId) {
      const userRows = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return userRows[0] ?? null;
    },
  };
}
