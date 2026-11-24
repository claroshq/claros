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
import { eq, and, sql, ne, isNull } from "drizzle-orm";
import { users, sessions, invites, tenants, transportConfigs } from "@claros/db/schema";
import { resolveTransportAdapter } from "@claros/adapters";
import { buildInviteEmail, type TransactionalEmailInput } from "../transactional-email.js";
import type { Db } from "../plugins/db.js";
import { RoleRouter } from "../http/router.js";

/** Invite token TTL: 7 days. */
const INVITE_TTL_DAYS = 7;

function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

export default function teamRoutes() {
  const router = new RoleRouter();
  /**
   * GET /v1/team
   * List all active team members for this tenant.
   */
  router.get("/", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

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

    return c.json({ members: rows });
  });

  /**
   * POST /v1/team/invites
   * Create a new invite. Returns the invite URL always (for copy-paste).
   * Sends a branded email if a transport is configured.
   */
  router.post(
    "/invites",
    "owner",
    async (c) => {
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;
      const inviterId = c.var.tenant!.userId;

      const { email, role } = (c.var.body as { email?: unknown; role?: unknown } | null | undefined) ?? {};
      if (!email || typeof email !== "string" || !email.includes("@")) {
        return c.json({ error: "A valid email address is required." }, 400);
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
        return c.json({ error: "That email is already a team member." }, 409);
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

      return c.json({
        invite: {
          id: inserted!.id,
          email: normalizedEmail,
          role: inviteRole,
          expires_at: expiresAt.toISOString(),
          invite_url: inviteUrl,
          email_sent: emailSent,
        },
      });
    },
  );

  /**
   * GET /v1/team/invites
   * List pending (unconsumed, unexpired) invites.
   */
  router.get("/invites", "owner", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

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

    return c.json({ invites: rows });
  });

  /**
   * DELETE /v1/team/invites/:id
   * Revoke a pending invite.
   */
  router.delete(
    "/invites/:id",
    "owner",
    async (c) => {
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;

      const id = c.req.param("id")!;
      const deleted = await db
        .delete(invites)
        .where(and(eq(invites.id, id), eq(invites.tenantId, tenantId)))
        .returning({ id: invites.id });

      if (deleted.length === 0) {
        return c.json({ error: "Invite not found." }, 404);
      }

      return c.json({ ok: true });
    },
  );

  /**
   * PATCH /v1/team/:id/role
   * Change a member's role. Cannot demote the last owner.
   */
  router.patch(
    "/:id/role",
    "owner",
    async (c) => {
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;

      const id = c.req.param("id")!;
      const { role } = (c.var.body as { role?: unknown } | null | undefined) ?? {};

      if (role !== "owner" && role !== "member") {
        return c.json({ error: "Role must be 'owner' or 'member'." }, 400);
      }

      // Load the target user
      const targetRows = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(and(eq(users.id, id), eq(users.tenantId, tenantId), isNull(users.deactivatedAt)))
        .limit(1);

      if (targetRows.length === 0) {
        return c.json({ error: "Member not found." }, 404);
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
          return c.json({ error: "Cannot demote the last owner. Promote another member first." }, 400);
        }
      }

      await db
        .update(users)
        .set({ role })
        .where(eq(users.id, id));

      return c.json({ ok: true, role });
    },
  );

  /**
   * DELETE /v1/team/:id
   * Remove a member. Immediately terminates their access by:
   *   1. Setting deactivated_at (soft delete - preserves attribution).
   *   2. Deleting all their sessions (immediate revocation).
   * Cannot remove the last owner.
   */
  router.delete(
    "/:id",
    "owner",
    async (c) => {
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;
      const currentUserId = c.var.tenant!.userId;

      const id = c.req.param("id")!;

      // Cannot remove yourself
      if (id === currentUserId) {
        return c.json({ error: "You cannot remove yourself. Transfer ownership first." }, 400);
      }

      // Load target
      const targetRows = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(and(eq(users.id, id), eq(users.tenantId, tenantId), isNull(users.deactivatedAt)))
        .limit(1);

      if (targetRows.length === 0) {
        return c.json({ error: "Member not found." }, 404);
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
          return c.json({ error: "Cannot remove the last owner." }, 400);
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

      return c.json({ ok: true });
    },
  );
  return router.app;
}
