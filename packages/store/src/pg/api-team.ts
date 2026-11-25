/**
 * Postgres implementation of the queries used by packages/api/src/routes/team.ts.
 */
import { eq, and, sql, isNull, or, isNotNull } from "drizzle-orm";
import { users, sessions, invites, tenants, memberships } from "@claros/db/schema";
import type { PgDb } from "./db.js";
import type { ApiTeamQueries } from "../areas/api-team.js";

/** Join condition: the user's membership row of the tenant (if any). */
function membershipOf(tenantId: string) {
  return and(eq(memberships.userId, users.id), eq(memberships.tenantId, tenantId));
}

/** Active members of the tenant: a membership row, or the tenant is the user's home. */
/** Role in the tenant: users.role in the home product (as in v0.6), else the membership role. */
function roleIn(tenantId: string) {
  return sql<string>`CASE WHEN ${users.tenantId} = ${tenantId} THEN ${users.role} ELSE ${memberships.role} END`;
}

function isActiveMemberOf(tenantId: string) {
  return and(
    isNull(users.deactivatedAt),
    or(isNotNull(memberships.userId), eq(users.tenantId, tenantId)),
  );
}


export function pgApiTeam(db: PgDb): ApiTeamQueries {
  return {
    async listMembers({ tenantId }) {
      return db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: roleIn(tenantId),
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
        })
        .from(users)
        .leftJoin(memberships, membershipOf(tenantId))
        .where(isActiveMemberOf(tenantId))
        .orderBy(users.createdAt);
    },

    async isActiveMemberEmail({ tenantId, email }) {
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .leftJoin(memberships, membershipOf(tenantId))
        .where(and(eq(users.email, email), isActiveMemberOf(tenantId)))
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
        .select({ id: users.id, role: roleIn(tenantId) })
        .from(users)
        .leftJoin(memberships, membershipOf(tenantId))
        .where(and(eq(users.id, userId), isActiveMemberOf(tenantId)))
        .limit(1);
      return targetRows[0] ?? null;
    },

    async countActiveOwners({ tenantId }) {
      const ownerCount = await db
        .select({ cnt: sql<number>`count(*)::int` })
        .from(users)
        .leftJoin(memberships, membershipOf(tenantId))
        .where(and(isActiveMemberOf(tenantId), sql`${roleIn(tenantId)} = 'owner'`));
      return ownerCount[0]?.cnt ?? 0;
    },

    async setRole({ tenantId, userId, role }) {
      await db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ userId, tenantId, role })
          .onConflictDoUpdate({ target: [memberships.userId, memberships.tenantId], set: { role } });
        // users.role stays the role in the home product (backward compatibility).
        await tx
          .update(users)
          .set({ role })
          .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
      });
    },

    async deactivateMember({ tenantId, userId, now }) {
      await db.transaction(async (tx) => {
        await tx
          .delete(memberships)
          .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)));

        // Removed from the home product: soft-delete the user, as before.
        const home = await tx
          .update(users)
          .set({ deactivatedAt: now })
          .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
          .returning({ id: users.id });

        // Delete sessions for immediate access revocation: all of them when
        // the user was deactivated, else the ones opened on this tenant.
        await tx
          .delete(sessions)
          .where(
            home.length > 0
              ? eq(sessions.userId, userId)
              : and(eq(sessions.userId, userId), eq(sessions.tenantId, tenantId)),
          );
      });
    },
  };
}
