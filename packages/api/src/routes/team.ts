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
import { storeFor } from "@claros/store";
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

    const rows = await storeFor(db).apiTeam.listMembers({ tenantId });

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
      if (await storeFor(db).apiTeam.isActiveMemberEmail({ tenantId, email: normalizedEmail })) {
        return c.json({ error: "That email is already a team member." }, 409);
      }

      // Generate token
      const { raw, hash } = generateToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

      // Insert invite
      const insertedId = await storeFor(db).apiTeam.createInvite({
        tenantId,
        email: normalizedEmail,
        role: inviteRole,
        tokenHash: hash,
        invitedBy: inviterId,
        expiresAt,
      });

      // Build the invite URL
      const dashboardUrl = process.env.DASHBOARD_URL || process.env.BASE_URL || "http://localhost:3000";
      const inviteUrl = `${dashboardUrl}/invite/accept?token=${raw}`;

      // Try to send branded invite email
      const tenant = (await storeFor(db).apiTeam.getTenantBrand({ tenantId }))!;
      const settings = (tenant.settings as Record<string, unknown> | null) ?? {};
      const brand = (settings.brand as Record<string, unknown> | undefined) ?? {};

      // Get inviter name for the email
      const inviterName = await storeFor(db).apiTeam.getUserName({ userId: inviterId });

      const emailInput: TransactionalEmailInput = {
        brand: brand as TransactionalEmailInput["brand"],
        tenantName: tenant.name,
      };

      const { html, text, subject } = buildInviteEmail(
        inviteUrl, inviterName, INVITE_TTL_DAYS, emailInput,
      );

      // Attempt send
      let emailSent = false;
      const transport = await storeFor(db).apiTeam.getActiveTransport({ tenantId });

      if (transport !== null) {
        const row = transport;
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
          id: insertedId,
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

    const rows = await storeFor(db).apiTeam.listPendingInvites({ tenantId });

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
      const deleted = await storeFor(db).apiTeam.deleteInvite({ tenantId, id });

      if (!deleted) {
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
      const target = await storeFor(db).apiTeam.getActiveMember({ tenantId, userId: id });

      if (target === null) {
        return c.json({ error: "Member not found." }, 404);
      }

      // If demoting from owner to member, check we won't be left with zero owners
      if (target.role === "owner" && role === "member") {
        const ownerCount = await storeFor(db).apiTeam.countActiveOwners({ tenantId });

        if (ownerCount <= 1) {
          return c.json({ error: "Cannot demote the last owner. Promote another member first." }, 400);
        }
      }

      await storeFor(db).apiTeam.setRole({ tenantId, userId: id, role });

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
      const target = await storeFor(db).apiTeam.getActiveMember({ tenantId, userId: id });

      if (target === null) {
        return c.json({ error: "Member not found." }, 404);
      }

      // If removing an owner, check we won't be left with zero owners
      if (target.role === "owner") {
        const ownerCount = await storeFor(db).apiTeam.countActiveOwners({ tenantId });

        if (ownerCount <= 1) {
          return c.json({ error: "Cannot remove the last owner." }, 400);
        }
      }

      // Deactivate user and delete sessions in one operation
      const now = new Date();
      await storeFor(db).apiTeam.deactivateMember({ tenantId, userId: id, now });

      return c.json({ ok: true });
    },
  );
  return router.app;
}
