/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-invite.ts.
 *
 * - consumeInvite: CAS UPDATE ... WHERE accepted_at IS NULL RETURNING (one
 *   statement, atomic on SQLite).
 * - reactivateUser, createUser, addMembership: the Postgres transactions are
 *   one D1 batch each (one SQLite transaction, all or nothing).
 * - findActiveUserElsewhere: oldest first, NULL created_at last (Postgres ASC).
 */
import { eq, and, isNull, ne, sql } from "drizzle-orm";
import { invites, users, sessions, tenants, memberships } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiInviteQueries } from "../areas/api-invite.js";

export function d1ApiInvite(db: D1Db): ApiInviteQueries {
  function upsertMembership(userId: string, tenantId: string, role: string) {
    return db
      .insert(memberships)
      .values({ userId, tenantId, role })
      .onConflictDoUpdate({ target: [memberships.userId, memberships.tenantId], set: { role } });
  }

  return {
    async findInviteByTokenHash(tokenHash) {
      const rows = await db
        .select({
          email: invites.email,
          expiresAt: invites.expiresAt,
          acceptedAt: invites.acceptedAt,
          tenantId: invites.tenantId,
        })
        .from(invites)
        .where(eq(invites.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ?? null;
    },

    async findTenantName(tenantId) {
      const rows = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      return rows[0]?.name ?? null;
    },

    async consumeInvite({ tokenHash, now }) {
      const consumed = await db
        .update(invites)
        .set({ acceptedAt: now })
        .where(and(eq(invites.tokenHash, tokenHash), isNull(invites.acceptedAt)))
        .returning({
          id: invites.id,
          email: invites.email,
          role: invites.role,
          tenantId: invites.tenantId,
          expiresAt: invites.expiresAt,
        });
      return consumed[0] ?? null;
    },

    async findUserByEmail({ tenantId, email }) {
      const rows = await db
        .select({ id: users.id, deactivatedAt: users.deactivatedAt })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
        .limit(1);
      return rows[0] ?? null;
    },

    async reactivateUser({ userId, tenantId, role, now }) {
      await db.batch([
        db.update(users).set({ deactivatedAt: null, role, lastLoginAt: now }).where(eq(users.id, userId)),
        upsertMembership(userId, tenantId, role),
      ]);
    },

    async createUser({ tenantId, email, role, now }) {
      const userId = crypto.randomUUID();
      await db.batch([
        db.insert(users).values({ id: userId, tenantId, email, role, lastLoginAt: now }),
        db.insert(memberships).values({ userId, tenantId, role }),
      ]);
      return userId;
    },

    async findActiveUserElsewhere({ tenantId, email }) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), ne(users.tenantId, tenantId), isNull(users.deactivatedAt)))
        .orderBy(sql`${users.createdAt} IS NULL`, users.createdAt)
        .limit(1);
      return rows[0] ?? null;
    },

    async addMembership({ userId, tenantId, role, now }) {
      await db.batch([
        upsertMembership(userId, tenantId, role),
        db.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId)),
      ]);
    },

    async createSession({ tenantId, userId, expiresAt }) {
      const [session] = await db
        .insert(sessions)
        .values({ tenantId, userId, expiresAt })
        .returning({ id: sessions.id });
      return session!.id;
    },
  };
}
