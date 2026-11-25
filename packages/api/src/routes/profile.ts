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
import { storeFor } from "@claros/store";
import { resolveTransportAdapter } from "@claros/adapters";
import { buildEmailChangeEmail, type TransactionalEmailInput } from "../transactional-email.js";
import type { Db } from "../plugins/db.js";
import { RoleRouter } from "../http/router.js";

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

export default function profileRoutes() {
  const r = new RoleRouter();
  /**
   * GET /v1/profile
   * Get the current user's profile.
   */
  r.get("/", "member", async (c) => {
    const db: Db = c.var.db;
    const userId = c.var.tenant!.userId;

    const user = (await storeFor(db).apiProfile.getProfile({ userId }))!;
    // Only show pending_email if it hasn't expired
    const pendingEmail =
      user.pendingEmail && user.pendingEmailExpiresAt && user.pendingEmailExpiresAt > new Date()
        ? user.pendingEmail
        : null;

    return c.json({
      profile: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        pending_email: pendingEmail,
        created_at: user.createdAt,
      },
    });
  });

  /**
   * PATCH /v1/profile
   * Update own name.
   */
  r.patch(
    "/",
    "member",
    async (c) => {
      const db: Db = c.var.db;
      const userId = c.var.tenant!.userId;

      const { name } = (c.var.body as { name?: string | null } | undefined) ?? {};
      if (name !== undefined && name !== null && typeof name !== "string") {
        return c.json({ error: "name must be a string or null." }, 400);
      }

      const trimmedName = name === null ? null : (name?.trim() || null);

      await storeFor(db).apiProfile.setName({ userId, name: trimmedName });

      return c.json({ ok: true });
    },
  );

  /**
   * POST /v1/profile/email
   * Request an email change. Sends verification link to the new address.
   * The old email remains active until the new one is verified.
   */
  r.post(
    "/email",
    "member",
    async (c) => {
      const db: Db = c.var.db;
      const userId = c.var.tenant!.userId;
      const tenantId = c.var.tenant!.id;

      const { email } = (c.var.body as { email: string } | undefined) ?? {};
      if (!email || typeof email !== "string" || !email.includes("@")) {
        return c.json({ error: "A valid email address is required." }, 400);
      }

      const newEmail = email.toLowerCase().trim();

      // Check current email - if same, no-op
      const currentEmail = await storeFor(db).apiProfile.getEmail({ userId });

      if (currentEmail === newEmail) {
        return c.json({ error: "That is already your current email." }, 400);
      }

      // Check if already taken at request time (early feedback, but we also
      // check at verification time for the race condition)
      if (await storeFor(db).apiProfile.isEmailTaken({ tenantId, email: newEmail })) {
        return c.json({ error: "That email is already in use by another team member." }, 409);
      }

      // Generate verification token
      const { raw, hash } = generateToken();
      const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_HOURS * 60 * 60 * 1000);

      // Store pending email on user row (overwrites any previous pending change)
      await storeFor(db).apiProfile.setPendingEmail({
        userId,
        pendingEmail: newEmail,
        tokenHash: hash,
        expiresAt,
      });

      // Build the verification URL
      const dashboardUrl = process.env.DASHBOARD_URL || process.env.BASE_URL || "http://localhost:3000";
      const verifyUrl = `${dashboardUrl}/auth/verify-email?token=${raw}`;

      // Resolve brand for branded email
      const tenant = (await storeFor(db).apiProfile.getTenantBrand({ tenantId }))!;
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
      const transport = await storeFor(db).apiProfile.getActiveTransport({ tenantId });

      let sent = false;
      if (transport !== null) {
        const row = transport;
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

      return c.json({
        ok: true,
        message: "Verification link sent to the new email address.",
        // In non-production, include URL for testing
        ...(process.env.NODE_ENV !== "production" ? { verify_url: verifyUrl } : {}),
      });
    },
  );

  /**
   * POST /v1/profile/email/verify
   * Confirm an email change by providing the verification token.
   * Checks for collision at verification time (handles race condition).
   */
  r.post(
    "/email/verify",
    "member",
    async (c) => {
      const db: Db = c.var.db;
      const userId = c.var.tenant!.userId;
      const tenantId = c.var.tenant!.id;

      const { token } = (c.var.body as { token: string } | undefined) ?? {};
      if (!token || typeof token !== "string") {
        return c.json({ error: "Token is required." }, 400);
      }

      const tokenHash = hashToken(token);

      // Load user's pending email
      const user = await storeFor(db).apiProfile.getPendingEmailChange({ userId });
      if (!user || !user.pendingEmail || !user.pendingEmailTokenHash || !user.pendingEmailExpiresAt) {
        return c.json({ error: "No pending email change." }, 400);
      }

      // Verify token
      if (user.pendingEmailTokenHash !== tokenHash) {
        return c.json({ error: "Invalid verification token." }, 400);
      }

      // Check expiry
      if (user.pendingEmailExpiresAt < new Date()) {
        return c.json({ error: "Verification link has expired. Please request a new one." }, 400);
      }

      // Check collision AT VERIFICATION TIME
      // Another user may have claimed this email between request and verification
      if (await storeFor(db).apiProfile.isEmailTaken({ tenantId, email: user.pendingEmail })) {
        // Clear the pending email - the change cannot proceed
        await storeFor(db).apiProfile.clearPendingEmail({ userId });

        return c.json({
          error: "That email address is now in use by another team member. Your email has not been changed.",
        }, 409);
      }

      // Atomically swap the email and clear pending fields
      await storeFor(db).apiProfile.applyEmailChange({ userId, email: user.pendingEmail });

      return c.json({ ok: true, email: user.pendingEmail });
    },
  );

  return r.app;
}
