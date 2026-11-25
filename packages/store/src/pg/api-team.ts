/**
 * Postgres implementation of the queries used by packages/api/src/routes/team.ts.
 */
import { eq, and, sql, isNull } from "drizzle-orm";
import { users, sessions, invites, tenants } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiTeamQueries } from "../areas/api-team.js";

export function pgApiTeam(db: PgDb): ApiTeamQueries {
  return {
    async listMembers({ tenantId }) {
      return db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), isNull(users.deactivatedAt)))
        .orderBy(users.createdAt);
    },

    async isActiveMemberEmail({ tenantId, email }) {
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(and(
          eq(users.tenantId, tenantId),
          eq(users.email, email),
          isNull(users.deactivatedAt),
        ))
        .limit(1);
      return existing.length > 0;
    },

    async createInvite({ tenantId, email, role, tokenHash, invitedBy, expiresAt }) {
      const [inserted] = await db
        .insert(invites)
        .values({
          tenantId,
          email,
          role,
          tokenHash,
          invitedBy,
          expiresAt,
        })
        .returning({ id: invites.id });
      return inserted!.id;
    },

    async getTenantBrand({ tenantId }) {
      const tenantRows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return tenantRows[0] ?? null;
    },

    async getUserName({ userId }) {
      const inviterRows = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return inviterRows[0]?.name ?? null;
    },

    async getActiveTransport({ tenantId }) {
      const transportRows = await db.execute<{
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
      return transportRows.rows[0] ?? null;
    },

    async listPendingInvites({ tenantId }) {
      return db
        .select({
          id: invites.id,
          email: invites.email,
          role: invites.role,
          expiresAt: invites.expiresAt,
          createdAt: invites.createdAt,
        })
        .from(invites)
        .where(and(
          eq(invites.tenantId, tenantId),
          isNull(invites.acceptedAt),
          sql`${invites.expiresAt} > now()`,
        ))
        .orderBy(invites.createdAt);
    },

    async deleteInvite({ tenantId, id }) {
      const deleted = await db
        .delete(invites)
        .where(and(eq(invites.id, id), eq(invites.tenantId, tenantId)))
        .returning({ id: invites.id });
      return deleted.length > 0;
    },

    async getActiveMember({ tenantId, userId }) {
      const targetRows = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.tenantId, tenantId), isNull(users.deactivatedAt)))
        .limit(1);
      return targetRows[0] ?? null;
    },

    async countActiveOwners({ tenantId }) {
      const ownerCount = await db
        .select({ cnt: sql<number>`count(*)::int` })
        .from(users)
        .where(and(
          eq(users.tenantId, tenantId),
          eq(users.role, "owner"),
          isNull(users.deactivatedAt),
        ));
      return ownerCount[0]?.cnt ?? 0;
    },

    async setRole({ userId, role }) {
      await db
        .update(users)
        .set({ role })
        .where(eq(users.id, userId));
    },

    async deactivateMember({ userId, now }) {
      await db
        .update(users)
        .set({ deactivatedAt: now })
        .where(eq(users.id, userId));

      // Delete all sessions for immediate access revocation
      await db
        .delete(sessions)
        .where(eq(sessions.userId, userId));
    },
  };
}
