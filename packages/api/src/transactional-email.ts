/**
 * Branded transactional email builder.
 *
 * All transactional emails (login link, invite, email-change verification)
 * go through the branded shell, just like lifecycle emails. This module
 * provides body-content builders for each transactional type; the caller
 * wraps the result in the shell via @claros/core email-shell.
 *
 * These emails are TRANSACTIONAL - they do not carry compliance footers
 * (no List-Unsubscribe, no postal address) because they are direct
 * responses to the recipient's own action. The shell's compliance slot
 * is filled with an empty string.
 */
import { wrapInShell, wrapInTextShell, type BrandSettings } from "@claros/core";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Button style shared across all transactional emails. */
const BUTTON_STYLE = "display:inline-block;padding:12px 24px;background:#26282e;color:#f7f7f9;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;";

export interface TransactionalEmailInput {
  brand: BrandSettings;
  tenantName: string;
}

// ---------------------------------------------------------------------------
// Login link email
// ---------------------------------------------------------------------------

export function buildLoginEmail(
  loginUrl: string,
  expiryMinutes: number,
  input: TransactionalEmailInput,
): { html: string; text: string } {
  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">You requested a login link. Click below to sign in:</p>`,
    `<p style="margin:0 0 24px 0;"><a href="${escapeHtmlAttr(loginUrl)}" style="${BUTTON_STYLE}">Sign in to Claros</a></p>`,
    `<p style="margin:0 0 8px 0;font-size:13px;color:#585d68;">Or copy this URL:<br/><span style="word-break:break-all;">${escapeHtml(loginUrl)}</span></p>`,
    `<p style="margin:0;font-size:13px;color:#585d68;">This link expires in ${expiryMinutes} minutes and can only be used once.</p>`,
  ].join("\n");

  const bodyText = [
    "You requested a login link. Open this URL to sign in:",
    "",
    loginUrl,
    "",
    `This link expires in ${expiryMinutes} minutes and can only be used once.`,
  ].join("\n");

  const html = wrapInShell({
    bodyHtml,
    // Claros' own mail (login, invites) keeps the layout brand.layout picks;
    // the product's email template is for its contacts' mail.
    brand: { ...input.brand, template: undefined },
    tenantName: input.tenantName,
    complianceFooterHtml: "",
  });

  const text = wrapInTextShell({
    bodyText,
    brand: input.brand,
    tenantName: input.tenantName,
    complianceFooterText: "",
  });

  return { html, text };
}

// ---------------------------------------------------------------------------
// Invite email
// ---------------------------------------------------------------------------

export function buildInviteEmail(
  inviteUrl: string,
  inviterName: string | null,
  expiryDays: number,
  input: TransactionalEmailInput,
): { html: string; text: string; subject: string } {
  const brandName = input.brand.brand_name || input.tenantName;
  const inviterLabel = inviterName || "A team member";

  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">${escapeHtml(inviterLabel)} has invited you to join <strong>${escapeHtml(brandName)}</strong> on Claros.</p>`,
    `<p style="margin:0 0 24px 0;"><a href="${escapeHtmlAttr(inviteUrl)}" style="${BUTTON_STYLE}">Accept invitation</a></p>`,
    `<p style="margin:0 0 8px 0;font-size:13px;color:#585d68;">Or copy this URL:<br/><span style="word-break:break-all;">${escapeHtml(inviteUrl)}</span></p>`,
    `<p style="margin:0;font-size:13px;color:#585d68;">This invitation expires in ${expiryDays} days.</p>`,
  ].join("\n");

  const bodyText = [
    `${inviterLabel} has invited you to join ${brandName} on Claros.`,
    "",
    "Accept the invitation by opening this URL:",
    "",
    inviteUrl,
    "",
    `This invitation expires in ${expiryDays} days.`,
  ].join("\n");

  const html = wrapInShell({
    bodyHtml,
    // Claros' own mail (login, invites) keeps the layout brand.layout picks;
    // the product's email template is for its contacts' mail.
    brand: { ...input.brand, template: undefined },
    tenantName: input.tenantName,
    complianceFooterHtml: "",
  });

  const text = wrapInTextShell({
    bodyText,
    brand: input.brand,
    tenantName: input.tenantName,
    complianceFooterText: "",
  });

  const subject = `You've been invited to ${brandName}`;

  return { html, text, subject };
}

// ---------------------------------------------------------------------------
// Email change verification
// ---------------------------------------------------------------------------

export function buildEmailChangeEmail(
  verifyUrl: string,
  newEmail: string,
  expiryHours: number,
  input: TransactionalEmailInput,
): { html: string; text: string; subject: string } {
  const brandName = input.brand.brand_name || input.tenantName;

  const bodyHtml = [
    `<p style="margin:0 0 16px 0;">You requested to change your email address on ${escapeHtml(brandName)} to <strong>${escapeHtml(newEmail)}</strong>.</p>`,
    `<p style="margin:0 0 16px 0;">Click below to confirm this change:</p>`,
    `<p style="margin:0 0 24px 0;"><a href="${escapeHtmlAttr(verifyUrl)}" style="${BUTTON_STYLE}">Confirm email change</a></p>`,
    `<p style="margin:0 0 8px 0;font-size:13px;color:#585d68;">Or copy this URL:<br/><span style="word-break:break-all;">${escapeHtml(verifyUrl)}</span></p>`,
    `<p style="margin:0;font-size:13px;color:#585d68;">This link expires in ${expiryHours} hours. If you did not request this change, ignore this email.</p>`,
  ].join("\n");

  const bodyText = [
    `You requested to change your email address on ${brandName} to ${newEmail}.`,
    "",
    "Confirm this change by opening this URL:",
    "",
    verifyUrl,
    "",
    `This link expires in ${expiryHours} hours. If you did not request this change, ignore this email.`,
  ].join("\n");

  const html = wrapInShell({
    bodyHtml,
    // Claros' own mail (login, invites) keeps the layout brand.layout picks;
    // the product's email template is for its contacts' mail.
    brand: { ...input.brand, template: undefined },
    tenantName: input.tenantName,
    complianceFooterHtml: "",
  });

  const text = wrapInTextShell({
    bodyText,
    brand: input.brand,
    tenantName: input.tenantName,
    complianceFooterText: "",
  });

  const subject = `Confirm your new email address`;

  return { html, text, subject };
}
