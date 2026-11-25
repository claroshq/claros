/**
 * Inputs for the pinned narrow-layout email shell output. The .html files
 * next to this file were rendered by wrapInShell before brand.layout
 * existed; email-shell.test.ts checks that the narrow layout (the default)
 * still renders them byte for byte.
 */
import type { EmailShellInput } from "../../../src/index.js";

const body = [
  '<h1 style="font-size:22px;font-weight:700;margin:0 0 16px 0;line-height:1.3;">Welcome</h1>',
  '<p style="margin:0 0 16px 0;line-height:1.6;">First paragraph with a <a href="https://example.com" style="color:#2563eb;text-decoration:underline;">link</a>.</p>',
  '<ul style="margin:0 0 16px 0;padding-left:24px;">',
  '<li style="margin:0 0 6px 0;line-height:1.5;">One</li>',
  "</ul>",
].join("\n");

export const NARROW_CASES: Record<string, EmailShellInput> = {
  defaults: {
    bodyHtml: "<p>Hi</p>",
    brand: {},
    tenantName: "Acme Inc",
    complianceFooterHtml: "",
  },
  full: {
    bodyHtml: body,
    brand: {
      brand_name: "Acme",
      logo_url: "https://news.example.com/brand/logo?v=1",
      logo_height: 40,
      accent_color: "#ff5500",
      footer_text: "You signed up at acme.example.",
      reply_to: "help@acme.example",
    },
    tenantName: "Acme Inc",
    complianceFooterHtml: '<p style="margin:0 0 4px 0;"><a href="https://x.example/unsub">Unsubscribe</a></p>\n<p style="margin:0;">1 Main St</p>',
    eyebrow: "Getting started",
    preheader: "Your first steps",
  },
  button: {
    bodyHtml:
      '<p style="margin:0 0 16px 0;">Click below:</p>\n<p style="margin:0 0 24px 0;"><a href="https://x.example/go" style="display:inline-block;padding:12px 24px;background:#26282e;color:#f7f7f9;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;">Go</a></p>',
    brand: { brand_name: "Acme" },
    tenantName: "Acme Inc",
    complianceFooterHtml: "",
  },
};
