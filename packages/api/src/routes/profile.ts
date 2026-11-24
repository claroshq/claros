/**
 * Profile routes - view/edit own profile and email change.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * Registered under /v1/profile inside the authenticated scope.
 *
 * Endpoints:
 *   GET    /v1/profile          - Get own profile
 *   PATCH  /v1/profile          - Update name
 *   POST   /v1/profile/email    - Request email change (verify-then-switch)
 *   POST   /v1/profile/email/verify - Confirm email change
 *
 * Email change design:
 *   1. User submits new email. We store it as pending_email on their user row,
 *      generate a verification token, and send a branded email to the new address.
 *   2. Until verified, login continues on the old email. Cannot lock yourself out.
 *   3. Clicking the verification link atomically swaps the email, checking for
 *      collisions at verification time (not just at request time).
 *   4. If never completed, pending_email expires after 24 hours - no harm done.
 */
import { randomBytes, createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { users, sessions, tenants, transportConfigs } from "@claros/db/schema";
import { resolveTransportAdapter } from "@claros/adapters";
import { buildEmailChangeEmail, type TransactionalEmailInput } from "../transactional-email.js";
import type { Db } from "../plugins/db.js";

/** Email change verification token TTL: 24 hours. */
const EMAIL_CHANGE_TTL_HOURS = 24;

function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const profileRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /v1/profile
   * Get the current user's profile.
   */
  app.get("/", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const userId = request.tenant!.userId;

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

    const user = rows[0]!;
    // Only show pending_email if it hasn't expired
    const pendingEmail =
      user.pendingEmail && user.pendingEmailExpiresAt && user.pendingEmailExpiresAt > new Date()
        ? user.pendingEmail
        : null;

    return {
      profile: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        pending_email: pendingEmail,
        created_at: user.createdAt,
      },
    };
  });

  /**
   * PATCH /v1/profile
   * Update own name.
   */
  app.patch<{ Body: { name?: string | null } }>(
    "/",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const userId = request.tenant!.userId;

      const { name } = request.body ?? {};
      if (name !== undefined && name !== null && typeof name !== "string") {
        reply.status(400);
        return { error: "name must be a string or null." };
      }

      const trimmedName = name === null ? null : (name?.trim() || null);

      await db
        .update(users)
        .set({ name: trimmedName })
        .where(eq(users.id, userId));

      return { ok: true };
    },
  );

  /**
   * POST /v1/profile/email
   * Request an email change. Sends verification link to the new address.
   * The old email remains active until the new one is verified.
   */
  app.post<{ Body: { email: string } }>(
    "/email",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const userId = request.tenant!.userId;
      const tenantId = request.tenant!.id;

      const { email } = request.body ?? {};
      if (!email || typeof email !== "string" || !email.includes("@")) {
        reply.status(400);
        return { error: "A valid email address is required." };
      }

      const newEmail = email.toLowerCase().trim();

      // Check current email - if same, no-op
      const currentRows = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (currentRows[0]?.email === newEmail) {
        reply.status(400);
        return { error: "That is already your current email." };
      }

      // Check if already taken at request time (early feedback, but we also
      // check at verification time for the race condition)
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.email, newEmail)))
        .limit(1);

      if (existing.length > 0) {
        reply.status(409);
        return { error: "That email is already in use by another team member." };
      }

      // Generate verification token
      const { raw, hash } = generateToken();
      const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_HOURS * 60 * 60 * 1000);

      // Store pending email on user row (overwrites any previous pending change)
      await db
        .update(users)
        .set({
          pendingEmail: newEmail,
          pendingEmailTokenHash: hash,
          pendingEmailExpiresAt: expiresAt,
        })
        .where(eq(users.id, userId));

      // Build the verification URL
      const dashboardUrl = process.env.DASHBOARD_URL || process.env.BASE_URL || "http://localhost:3000";
      const verifyUrl = `${dashboardUrl}/auth/verify-email?token=${raw}`;

      // Resolve brand for branded email
      const tenantRows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const tenant = tenantRows[0]!;
      const settings = (tenant.settings as Record<string, unknown> | null) ?? {};
      const brand = (settings.brand as Record<string, unknown> | undefined) ?? {};

      const emailInput: TransactionalEmailInput = {
        brand: brand as TransactionalEmailInput["brand"],
        tenantName: tenant.name,
      };

      const { html, text, subject } = buildEmailChangeEmail(
        verifyUrl, newEmail, EMAIL_CHANGE_TTL_HOURS, emailInput,
      );

      // Try to send via transport
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

      let sent = false;
      if (transports.rows.length > 0) {
        const row = transports.rows[0]!;
        const result = resolveTransportAdapter(row.provider, row.config);
        if (result.ok) {
          try {
            const sendResult = await result.transport.adapter.send({
              to: newEmail,
              from: row.from_email,
              fromName: row.from_name ?? undefined,
              subject,
              bodyHtml: html,
              bodyText: text,
              headers: {},
              messageId: `email-change-${hash}`,
            });
            sent = sendResult.success;
          } catch {
            // Fall through to console
          }
        }
      }

      if (!sent && process.env.NODE_ENV !== "production") {
        console.log("");
        console.log("========================================");
        console.log("  EMAIL CHANGE VERIFICATION LINK");
        console.log("========================================");
        console.log(`  New email: ${newEmail}`);
        console.log(`  URL:       ${verifyUrl}`);
        console.log(`  Expires:   ${EMAIL_CHANGE_TTL_HOURS} hours`);
        console.log("========================================");
        console.log("");
      }

      return {
        ok: true,
        message: "Verification link sent to the new email address.",
        // In non-production, include URL for testing
        ...(process.env.NODE_ENV !== "production" ? { verify_url: verifyUrl } : {}),
      };
    },
  );

  /**
   * POST /v1/profile/email/verify
   * Confirm an email change by providing the verification token.
   * Checks for collision at verification time (handles race condition).
   */
  app.post<{ Body: { token: string } }>(
    "/email/verify",
    { config: { minRole: "member" } },
    async (request, reply) => {
      const db: Db = request.server.db;
      const userId = request.tenant!.userId;
      const tenantId = request.tenant!.id;

      const { token } = request.body ?? {};
      if (!token || typeof token !== "string") {
        reply.status(400);
        return { error: "Token is required." };
      }

      const tokenHash = hashToken(token);

      // Load user's pending email
      const userRows = await db
        .select({
          pendingEmail: users.pendingEmail,
          pendingEmailTokenHash: users.pendingEmailTokenHash,
          pendingEmailExpiresAt: users.pendingEmailExpiresAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const user = userRows[0];
      if (!user || !user.pendingEmail || !user.pendingEmailTokenHash || !user.pendingEmailExpiresAt) {
        reply.status(400);
        return { error: "No pending email change." };
      }

      // Verify token
      if (user.pendingEmailTokenHash !== tokenHash) {
        reply.status(400);
        return { error: "Invalid verification token." };
      }

      // Check expiry
      if (user.pendingEmailExpiresAt < new Date()) {
        reply.status(400);
        return { error: "Verification link has expired. Please request a new one." };
      }

      // Check collision AT VERIFICATION TIME
      // Another user may have claimed this email between request and verification
      const collision = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.email, user.pendingEmail)))
        .limit(1);

      if (collision.length > 0) {
        // Clear the pending email - the change cannot proceed
        await db
          .update(users)
          .set({ pendingEmail: null, pendingEmailTokenHash: null, pendingEmailExpiresAt: null })
          .where(eq(users.id, userId));

        reply.status(409);
        return {
          error: "That email address is now in use by another team member. Your email has not been changed.",
        };
      }

      // Atomically swap the email and clear pending fields
      await db
        .update(users)
        .set({
          email: user.pendingEmail,
          pendingEmail: null,
          pendingEmailTokenHash: null,
          pendingEmailExpiresAt: null,
        })
        .where(eq(users.id, userId));

      return { ok: true, email: user.pendingEmail };
    },
  );
};

export default profileRoutes;
