/**
 * SQLite / Cloudflare D1 implementation of the queries in ../areas/api-team.ts.
 *
 * - Orderings put NULL created_at last, as Postgres ASC does.
 * - listPendingInvites: "now" is the Worker clock (Postgres uses now()).
 * - setRole, deactivateMember: the Postgres transactions are one D1 batch
 *   each. deactivateMember decides "all sessions or this tenant's" inside the
 *   DELETE (is this tenant the user's home product?) instead of from the
 *   UPDATE's returned rows; same outcome, one atomic batch.
 */
import { eq, and, sql, isNull, or, isNotNull } from "drizzle-orm";
import { users, sessions, invites, tenants, memberships } from "@claros/db/schema-sqlite";
import type { D1Db } from "./db.js";
import type { ApiTeamQueries } from "../areas/api-team.js";
import { findActiveTransportText } from "./transport-text.js";

/** Join condition: the user's membership row of the tenant (if any). */
function membershipOf(tenantId: string) {
  return and(eq(memberships.userId, users.id), eq(memberships.tenantId, tenantId));
}

/** Role in the tenant: users.role in the home product, else the membership role. */
function roleIn(tenantId: string) {
  return sql<string>`CASE WHEN ${users.tenantId} = ${tenantId} THEN ${users.role} ELSE ${memberships.role} END`;
}

/** Active members of the tenant: a membership row, or the tenant is the user's home. */
function isActiveMemberOf(tenantId: string) {
  return and(isNull(users.deactivatedAt), or(isNotNull(memberships.userId), eq(users.tenantId, tenantId)));
}

export function d1ApiTeam(db: D1Db): ApiTeamQueries {
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
        .orderBy(sql`${users.createdAt} IS NULL`, users.createdAt);
    },

    async isActiveMemberEmail({ tenantId, email }) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .leftJoin(memberships, membershipOf(tenantId))
        .where(and(eq(users.email, email), isActiveMemberOf(tenantId)))
        .limit(1);
      return rows.length > 0;
    },

    async createInvite({ tenantId, email, role, tokenHash, invitedBy, expiresAt }) {
      const [inserted] = await db
        .insert(invites)
        .values({ tenantId, email, role, tokenHash, invitedBy, expiresAt })
        .returning({ id: invites.id });
      return inserted!.id;
    },

    async getTenantBrand({ tenantId }) {
      const rows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0] ?? null;
    },

    async getUserName({ userId }) {
      const rows = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
      return rows[0]?.name ?? null;
    },

    async getActiveTransport({ tenantId }) {
      return findActiveTransportText(db, tenantId);
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
          sql`${invites.expiresAt} > ${Date.now()}`,
        ))
        .orderBy(sql`${invites.createdAt} IS NULL`, invites.createdAt);
    },

    async deleteInvite({ tenantId, id }) {
      const deleted = await db
        .delete(invites)
        .where(and(eq(invites.id, id), eq(invites.tenantId, tenantId)))
        .returning({ id: invites.id });
      return deleted.length > 0;
    },

    async getActiveMember({ tenantId, userId }) {
      const rows = await db
        .select({ id: users.id, role: roleIn(tenantId) })
        .from(users)
        .leftJoin(memberships, membershipOf(tenantId))
        .where(and(eq(users.id, userId), isActiveMemberOf(tenantId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async countActiveOwners({ tenantId }) {
      const rows = await db
        .select({ cnt: sql<number>`count(*)` })
        .from(users)
        .leftJoin(memberships, membershipOf(tenantId))
        .where(and(isActiveMemberOf(tenantId), sql`${roleIn(tenantId)} = 'owner'`));
      return rows[0]?.cnt ?? 0;
    },

    async setRole({ tenantId, userId, role }) {
      await db.batch([
        db
          .insert(memberships)
          .values({ userId, tenantId, role })
          .onConflictDoUpdate({ target: [memberships.userId, memberships.tenantId], set: { role } }),
        // users.role stays the role in the home product.
        db.update(users).set({ role }).where(and(eq(users.id, userId), eq(users.tenantId, tenantId))),
      ]);
    },

    async deactivateMember({ tenantId, userId, now }) {
      await db.batch([
        db.delete(memberships).where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId))),
        // Removed from the home product: soft-delete the user.
        db
          .update(users)
          .set({ deactivatedAt: now })
          .where(and(eq(users.id, userId), eq(users.tenantId, tenantId))),
        // All sessions when this is the user's home product, else this tenant's.
        db.delete(sessions).where(
          and(
            eq(sessions.userId, userId),
            or(
              eq(sessions.tenantId, tenantId),
              sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${userId} AND u.tenant_id = ${tenantId})`,
            ),
          ),
        ),
      ]);
    },
  };
}
