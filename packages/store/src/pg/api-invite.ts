/**
 * Postgres implementation of the queries used by packages/api/src/routes/invite.ts.
 */
import { eq, and, isNull, ne, asc } from "drizzle-orm";
import { invites, users, sessions, tenants, memberships } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiInviteQueries } from "../areas/api-invite.js";

export function pgApiInvite(db: PgDb): ApiInviteQueries {
  return {
    async findInviteByTokenHash(tokenHash) {
      // Read-only lookup
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
      const tenantRows = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return tenantRows[0]?.name ?? null;
    },

    async consumeInvite({ tokenHash, now }) {
      // Atomic CAS: consume the invite only if not yet consumed
      const consumed = await db
        .update(invites)
        .set({ acceptedAt: now })
        .where(
          and(
            eq(invites.tokenHash, tokenHash),
            isNull(invites.acceptedAt),
          ),
        )
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
      const existingUser = await db
        .select({ id: users.id, deactivatedAt: users.deactivatedAt })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
        .limit(1);
      return existingUser[0] ?? null;
    },

    async reactivateUser({ userId, tenantId, role, now }) {
      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ deactivatedAt: null, role, lastLoginAt: now })
          .where(eq(users.id, userId));
        await tx
          .insert(memberships)
          .values({ userId, tenantId, role })
          .onConflictDoUpdate({ target: [memberships.userId, memberships.tenantId], set: { role } });
      });
    },

    async createUser({ tenantId, email, role, now }) {
      return db.transaction(async (tx) => {
        const [newUser] = await tx
          .insert(users)
          .values({
            tenantId,
            email,
            role,
            lastLoginAt: now,
          })
          .returning({ id: users.id });
        await tx.insert(memberships).values({ userId: newUser!.id, tenantId, role });
        return newUser!.id;
      });
    },

    async findActiveUserElsewhere({ tenantId, email }) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), ne(users.tenantId, tenantId), isNull(users.deactivatedAt)))
        .orderBy(asc(users.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    async addMembership({ userId, tenantId, role, now }) {
      await db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ userId, tenantId, role })
          .onConflictDoUpdate({ target: [memberships.userId, memberships.tenantId], set: { role } });
        await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId));
      });
    },

    async createSession({ tenantId, userId, expiresAt }) {
      const [session] = await db
        .insert(sessions)
        .values({
          tenantId,
          userId,
          expiresAt,
        })
        .returning({ id: sessions.id });
      return session!.id;
    },
  };
}
