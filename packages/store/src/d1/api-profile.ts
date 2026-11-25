/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-profile.ts.
 */
import { eq, and } from "drizzle-orm";
import { users, tenants } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiProfileQueries } from "../areas/api-profile.js";
import { findActiveTransportText } from "./transport-text.js";

export function d1ApiProfile(db: D1Db): ApiProfileQueries {
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
      await db.update(users).set({ name }).where(eq(users.id, userId));
    },

    async getEmail({ userId }) {
      const rows = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
      return rows[0]?.email ?? null;
    },

    async isEmailTaken({ tenantId, email }) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
        .limit(1);
      return rows.length > 0;
    },

    async setPendingEmail({ userId, pendingEmail, tokenHash, expiresAt }) {
      await db
        .update(users)
        .set({ pendingEmail, pendingEmailTokenHash: tokenHash, pendingEmailExpiresAt: expiresAt })
        .where(eq(users.id, userId));
    },

    async getTenantBrand({ tenantId }) {
      const rows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0] ?? null;
    },

    async getActiveTransport({ tenantId }) {
      return findActiveTransportText(db, tenantId);
    },

    async getPendingEmailChange({ userId }) {
      const rows = await db
        .select({
          pendingEmail: users.pendingEmail,
          pendingEmailTokenHash: users.pendingEmailTokenHash,
          pendingEmailExpiresAt: users.pendingEmailExpiresAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0] ?? null;
    },

    async clearPendingEmail({ userId }) {
      await db
        .update(users)
        .set({ pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null })
        .where(eq(users.id, userId));
    },

    async applyEmailChange({ userId, email }) {
      // One UPDATE: swap the email and clear the pending fields.
      await db
        .update(users)
        .set({ email, pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null })
        .where(eq(users.id, userId));
    },
  };
}
