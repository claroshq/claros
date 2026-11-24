/**
 * Email templates CRUD routes - operator editing of email content.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * Registered under the /v1/email-templates prefix inside the authenticated scope.
 *
 * Endpoints:
 *   GET    /v1/email-templates          list email templates for the tenant
 *   GET    /v1/email-templates/:id      get a single template
 *   PATCH  /v1/email-templates/:id      update subject, body_html, body_text
 *
 * Editing a template changes the stored content but does NOT bypass the shell.
 * The template body is always wrapped in the branded shell at drain time.
 */
import { z } from "zod";
import { RoleRouter, validatedBody } from "../http/router.js";
import { validateBody, coerceString } from "../http/validate.js";
import { eq, and } from "drizzle-orm";
import { templates } from "@claros/db/schema";
import type { Db } from "../plugins/db.js";

/**
 * Supported template variable prefixes. Mirrors the authoritative list in
 * packages/worker/src/template-renderer.ts. The renderer validates against
 * these at render time; this list is returned by the GET endpoints so the
 * dashboard can show operators what variables are available.
 */
const SUPPORTED_VARIABLES = [
  "contact.first_name",
  "contact.last_name",
  "contact.email",
  "contact.external_id",
  "contact.properties.*",
  "tenant.name",
  "flow.name",
] as const;

/**
 * PATCH /v1/email-templates/:id body. Same rules as the v0.6 JSON schema:
 * subject and body_html are strings, body_text is a string or null, all
 * optional; unknown properties are removed and scalars coerced to string.
 */
const patchTemplateBodySchema = z.object({
  subject: coerceString().optional(),
  body_html: coerceString().optional(),
  body_text: coerceString().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default function emailTemplatesRoutes() {
  const r = new RoleRouter();
  /**
   * GET /v1/email-templates
   * List all email templates for the calling tenant.
   */
  r.get("/", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const rows = await db
      .select({
        id: templates.id,
        name: templates.name,
        slug: templates.slug,
        subject: templates.subject,
        bodyHtml: templates.bodyHtml,
        bodyText: templates.bodyText,
        variables: templates.variables,
        category: templates.category,
        isActive: templates.isActive,
        createdAt: templates.createdAt,
      })
      .from(templates)
      .where(eq(templates.tenantId, tenantId));

    return c.json({
      templates: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        subject: r.subject,
        body_html: r.bodyHtml,
        body_text: r.bodyText,
        variables: r.variables,
        category: r.category,
        is_active: r.isActive,
        created_at: r.createdAt,
      })),
      supported_variables: SUPPORTED_VARIABLES,
    });
  });

  /**
   * GET /v1/email-templates/:id
   * Get a single template by ID.
   */
  r.get("/:id", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const id = c.req.param("id")!;

    const rows = await db
      .select({
        id: templates.id,
        name: templates.name,
        slug: templates.slug,
        subject: templates.subject,
        bodyHtml: templates.bodyHtml,
        bodyText: templates.bodyText,
        variables: templates.variables,
        category: templates.category,
        isActive: templates.isActive,
        createdAt: templates.createdAt,
      })
      .from(templates)
      .where(and(eq(templates.id, id), eq(templates.tenantId, tenantId)));

    if (rows.length === 0) {
      return c.json({ error: "Template not found." }, 404);
    }

    const r = rows[0]!;
    return c.json({
      template: {
        id: r.id,
        name: r.name,
        slug: r.slug,
        subject: r.subject,
        body_html: r.bodyHtml,
        body_text: r.bodyText,
        variables: r.variables,
        category: r.category,
        is_active: r.isActive,
        created_at: r.createdAt,
      },
      supported_variables: SUPPORTED_VARIABLES,
    });
  });

  /**
   * PATCH /v1/email-templates/:id
   * Update template content. Supports subject, body_html, body_text.
   * All fields are optional - only provided fields are updated.
   */
  r.patch(
    "/:id",
    "member",
    validatedBody(patchTemplateBodySchema),
    async (c) => {
      const v = validateBody(c, patchTemplateBodySchema);
      if (!v.ok) return v.response;
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;
      const id = c.req.param("id")!;
      const { subject, body_html, body_text } = v.value;

      // Must provide at least one field
      if (subject === undefined && body_html === undefined && body_text === undefined) {
        return c.json({ error: "No updatable fields provided. Supported: subject, body_html, body_text." }, 400);
      }

      // Validate non-empty subject
      if (subject !== undefined && subject.trim().length === 0) {
        return c.json({ error: "subject must be a non-empty string." }, 400);
      }

      // Validate non-empty body_html
      if (body_html !== undefined && body_html.trim().length === 0) {
        return c.json({ error: "body_html must be a non-empty string." }, 400);
      }

      // Build update set
      const updates: Record<string, unknown> = {};
      if (subject !== undefined) updates.subject = subject.trim();
      if (body_html !== undefined) updates.bodyHtml = body_html.trim();
      if (body_text !== undefined) updates.bodyText = body_text?.trim() || null;

      const result = await db
        .update(templates)
        .set(updates)
        .where(and(eq(templates.id, id), eq(templates.tenantId, tenantId)))
        .returning({
          id: templates.id,
          name: templates.name,
          slug: templates.slug,
          subject: templates.subject,
          bodyHtml: templates.bodyHtml,
          bodyText: templates.bodyText,
          variables: templates.variables,
          category: templates.category,
          isActive: templates.isActive,
          createdAt: templates.createdAt,
        });

      if (result.length === 0) {
        return c.json({ error: "Template not found." }, 404);
      }

      const r = result[0]!;
      return c.json({
        template: {
          id: r.id,
          name: r.name,
          slug: r.slug,
          subject: r.subject,
          body_html: r.bodyHtml,
          body_text: r.bodyText,
          variables: r.variables,
          category: r.category,
          is_active: r.isActive,
          created_at: r.createdAt,
        },
      });
    },
  );
  return r.app;
}
