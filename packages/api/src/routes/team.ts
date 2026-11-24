/**
 * Team routes - member management, invites, role changes.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * Registered under /v1/team inside the authenticated scope.
 *
 * Endpoints:
 *   GET    /v1/team             - List team members
 *   POST   /v1/team/invites     - Create an invite (owner-only)
 *   GET    /v1/team/invites     - List pending invites (owner-only)
 *   DELETE /v1/team/invites/:id - Revoke a pending invite (owner-only)
 *   PATCH  /v1/team/:id/role    - Change a member's role (owner-only)
 *   DELETE /v1/team/:id         - Remove a member (owner-only)
 *
 * Invariants:
 *   - An install must always have at least one active owner.
 *   - Removing the last owner is rejected.
 *   - Demoting the last owner is rejected.
 *   - Removing a member immediately terminates their sessions (deactivated_at).
 *   - Work attributed to removed members (approvals, etc.) is preserved.
 */
import { randomBytes, createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { eq, and, sql, ne, isNull } from "drizzle-orm";
import { users, sessions, invites, tenants, transportConfigs } from "@claros/db/schema";
import { resolveTransportAdapter } from "@claros/adapters";
import { buildInviteEmail, type TransactionalEmailInput } from "../transactional-email.js";
import type { Db } from "../plugins/db.js";

/** Invite token TTL: 7 days. */
const INVITE_TTL_DAYS = 7;

function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

const teamRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /v1/team
   * List all active team members for this tenant.
   */
  app.get("/", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rows = await db
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

    return { members: rows };
  });

  /**
   * POST /v1/team/invites
   * Create a new invite. Returns the invite URL always (for copy-paste).
   * Sends a branded email if a transport is configured.
   */
  app.post<{ Body: { email: string; role?: string } }>(
    "/invites",
    { config: { minRole: "owner" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const inviterId = request.tenant!.userId;

      const { email, role } = request.body ?? {};
      if (!email || typeof email !== "string" || !email.includes("@")) {
        reply.status(400);
        return { error: "A valid email address is required." };
      }

      const normalizedEmail = email.toLowerCase().trim();
      const inviteRole = role === "owner" ? "owner" : "member";

      // Check if email is already a member
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(and(
          eq(users.tenantId, tenantId),
          eq(users.email, normalizedEmail),
          isNull(users.deactivatedAt),
        ))
        .limit(1);

      if (existing.length > 0) {
        reply.status(409);
        return { error: "That email is already a team member." };
      }

      // Generate token
      const { raw, hash } = generateToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

      // Insert invite
      const [inserted] = await db
        .insert(invites)
        .values({
          tenantId,
          email: normalizedEmail,
          role: inviteRole,
          tokenHash: hash,
          invitedBy: inviterId,
          expiresAt,
        })
        .returning({ id: invites.id });

      // Build the invite URL
      const dashboardUrl = process.env.DASHBOARD_URL || process.env.BASE_URL || "http://localhost:3000";
      const inviteUrl = `${dashboardUrl}/invite/accept?token=${raw}`;

      // Try to send branded invite email
      const tenantRows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const tenant = tenantRows[0]!;
      const settings = (tenant.settings as Record<string, unknown> | null) ?? {};
      const brand = (settings.brand as Record<string, unknown> | undefined) ?? {};

      // Get inviter name for the email
      const inviterRows = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, inviterId))
        .limit(1);
      const inviterName = inviterRows[0]?.name ?? null;

      const emailInput: TransactionalEmailInput = {
        brand: brand as TransactionalEmailInput["brand"],
        tenantName: tenant.name,
      };

      const { html, text, subject } = buildInviteEmail(
        inviteUrl, inviterName, INVITE_TTL_DAYS, emailInput,
      );

      // Attempt send
      let emailSent = false;
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

      if (transportRows.rows.length > 0) {
        const row = transportRows.rows[0]!;
        const result = resolveTransportAdapter(row.provider, row.config);
        if (result.ok) {
          try {
            const sendResult = await result.transport.adapter.send({
              to: normalizedEmail,
              from: row.from_email,
              fromName: row.from_name ?? undefined,
              subject,
              bodyHtml: html,
              bodyText: text,
              headers: {},
              messageId: `invite-${hash}`,
            });
            emailSent = sendResult.success;
          } catch {
            // Fall through - URL is always returned
          }
        }
      }

      if (!emailSent && process.env.NODE_ENV !== "production") {
        console.log("");
        console.log("========================================");
        console.log("  TEAM INVITE LINK");
        console.log("========================================");
        console.log(`  Email: ${normalizedEmail}`);
        console.log(`  Role:  ${inviteRole}`);
        console.log(`  URL:   ${inviteUrl}`);
        console.log(`  Expires: ${INVITE_TTL_DAYS} days`);
        console.log("========================================");
        console.log("");
      }

      return {
        invite: {
          id: inserted!.id,
          email: normalizedEmail,
          role: inviteRole,
          expires_at: expiresAt.toISOString(),
          invite_url: inviteUrl,
          email_sent: emailSent,
        },
      };
    },
  );

  /**
   * GET /v1/team/invites
   * List pending (unconsumed, unexpired) invites.
   */
  app.get("/invites", { config: { minRole: "owner" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rows = await db
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

    return { invites: rows };
  });

  /**
   * DELETE /v1/team/invites/:id
   * Revoke a pending invite.
   */
  app.delete<{ Params: { id: string } }>(
    "/invites/:id",
    { config: { minRole: "owner" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;

      const { id } = request.params;
      const deleted = await db
        .delete(invites)
        .where(and(eq(invites.id, id), eq(invites.tenantId, tenantId)))
        .returning({ id: invites.id });

      if (deleted.length === 0) {
        reply.status(404);
        return { error: "Invite not found." };
      }

      return { ok: true };
    },
  );

  /**
   * PATCH /v1/team/:id/role
   * Change a member's role. Cannot demote the last owner.
   */
  app.patch<{ Params: { id: string }; Body: { role: string } }>(
    "/:id/role",
    { config: { minRole: "owner" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;

      const { id } = request.params;
      const { role } = request.body ?? {};

      if (role !== "owner" && role !== "member") {
        reply.status(400);
        return { error: "Role must be 'owner' or 'member'." };
      }

      // Load the target user
      const targetRows = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(and(eq(users.id, id), eq(users.tenantId, tenantId), isNull(users.deactivatedAt)))
        .limit(1);

      if (targetRows.length === 0) {
        reply.status(404);
        return { error: "Member not found." };
      }

      const target = targetRows[0]!;

      // If demoting from owner to member, check we won't be left with zero owners
      if (target.role === "owner" && role === "member") {
        const ownerCount = await db
          .select({ cnt: sql<number>`count(*)::int` })
          .from(users)
          .where(and(
            eq(users.tenantId, tenantId),
            eq(users.role, "owner"),
            isNull(users.deactivatedAt),
          ));

        if ((ownerCount[0]?.cnt ?? 0) <= 1) {
          reply.status(400);
          return { error: "Cannot demote the last owner. Promote another member first." };
        }
      }

      await db
        .update(users)
        .set({ role })
        .where(eq(users.id, id));

      return { ok: true, role };
    },
  );

  /**
   * DELETE /v1/team/:id
   * Remove a member. Immediately terminates their access by:
   *   1. Setting deactivated_at (soft delete - preserves attribution).
   *   2. Deleting all their sessions (immediate revocation).
   * Cannot remove the last owner.
   */
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { config: { minRole: "owner" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const currentUserId = request.tenant!.userId;

      const { id } = request.params;

      // Cannot remove yourself
      if (id === currentUserId) {
        reply.status(400);
        return { error: "You cannot remove yourself. Transfer ownership first." };
      }

      // Load target
      const targetRows = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(and(eq(users.id, id), eq(users.tenantId, tenantId), isNull(users.deactivatedAt)))
        .limit(1);

      if (targetRows.length === 0) {
        reply.status(404);
        return { error: "Member not found." };
      }

      const target = targetRows[0]!;

      // If removing an owner, check we won't be left with zero owners
      if (target.role === "owner") {
        const ownerCount = await db
          .select({ cnt: sql<number>`count(*)::int` })
          .from(users)
          .where(and(
            eq(users.tenantId, tenantId),
            eq(users.role, "owner"),
            isNull(users.deactivatedAt),
          ));

        if ((ownerCount[0]?.cnt ?? 0) <= 1) {
          reply.status(400);
          return { error: "Cannot remove the last owner." };
        }
      }

      // Deactivate user and delete sessions in one operation
      const now = new Date();
      await db
        .update(users)
        .set({ deactivatedAt: now })
        .where(eq(users.id, id));

      // Delete all sessions for immediate access revocation
      await db
        .delete(sessions)
        .where(eq(sessions.userId, id));

      return { ok: true };
    },
  );
};

export default teamRoutes;
