/**
 * Postgres implementation of the queries used by packages/api/src/routes/profile.ts.
 */
import { eq, and, sql } from "drizzle-orm";
import { users, tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiProfileQueries } from "../areas/api-profile.js";

export function pgApiProfile(db: PgDb): ApiProfileQueries {
  return {
    async getProfile({ userId }) {
      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          pendingEmail: users.pendingEmail,
          pendingEmailExpiresAt: users.pendingEmailExpiresAt,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0] ?? null;
    },

    async setName({ userId, name }) {
      await db
        .update(users)
        .set({ name })
        .where(eq(users.id, userId));
    },

    async getEmail({ userId }) {
      const currentRows = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return currentRows[0]?.email ?? null;
    },

    async isEmailTaken({ tenantId, email }) {
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
        .limit(1);
      return existing.length > 0;
    },

    async setPendingEmail({ userId, pendingEmail, tokenHash, expiresAt }) {
      await db
        .update(users)
        .set({
          pendingEmail,
          pendingEmailTokenHash: tokenHash,
          pendingEmailExpiresAt: expiresAt,
        })
        .where(eq(users.id, userId));
    },

    async getTenantBrand({ tenantId }) {
      const tenantRows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return tenantRows[0] ?? null;
    },

    async getActiveTransport({ tenantId }) {
      const transports = await db.execute<{
        provider: string;
        config: string;
        from_email: string;
        from_name: string | null;
      }>(sql`
        SELECT provider, config::text AS config, from_email, from_name
        FROM transport_configs
        WHERE tenant_id = ${tenantId}::uuid AND is_active = true
        LIMIT 1
      `);
      return transports.rows[0] ?? null;
    },

    async getPendingEmailChange({ userId }) {
      const userRows = await db
        .select({
          pendingEmail: users.pendingEmail,
          pendingEmailTokenHash: users.pendingEmailTokenHash,
          pendingEmailExpiresAt: users.pendingEmailExpiresAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return userRows[0] ?? null;
    },

    async clearPendingEmail({ userId }) {
      await db
        .update(users)
        .set({ pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null })
        .where(eq(users.id, userId));
    },

    async applyEmailChange({ userId, email }) {
      // Atomically swap the email and clear pending fields
      await db
        .update(users)
        .set({
          email,
          pendingEmail: null,
          pendingEmailTokenHash: null,
          pendingEmailExpiresAt: null,
        })
        .where(eq(users.id, userId));
    },
  };
}
