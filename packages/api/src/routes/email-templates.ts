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
import type { FastifyPluginAsync } from "fastify";
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

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const emailTemplatesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /v1/email-templates
   * List all email templates for the calling tenant.
   */
  app.get("/", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

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

    return {
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
    };
  });

  /**
   * GET /v1/email-templates/:id
   * Get a single template by ID.
   */
  app.get<{ Params: { id: string } }>("/:id", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;
    const { id } = request.params;

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
      reply.status(404);
      return { error: "Template not found." };
    }

    const r = rows[0]!;
    return {
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
    };
  });

  /**
   * PATCH /v1/email-templates/:id
   * Update template content. Supports subject, body_html, body_text.
   * All fields are optional - only provided fields are updated.
   */
  app.patch<{
    Params: { id: string };
    Body: {
      subject?: string;
      body_html?: string;
      body_text?: string | null;
    };
  }>(
    "/:id",
    {
      config: { minRole: "member" as const },
      schema: {
        body: {
          type: "object",
          properties: {
            subject: { type: "string" },
            body_html: { type: "string" },
            body_text: { type: ["string", "null"] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const { id } = request.params;
      const { subject, body_html, body_text } = request.body;

      // Must provide at least one field
      if (subject === undefined && body_html === undefined && body_text === undefined) {
        reply.status(400);
        return { error: "No updatable fields provided. Supported: subject, body_html, body_text." };
      }

      // Validate non-empty subject
      if (subject !== undefined && subject.trim().length === 0) {
        reply.status(400);
        return { error: "subject must be a non-empty string." };
      }

      // Validate non-empty body_html
      if (body_html !== undefined && body_html.trim().length === 0) {
        reply.status(400);
        return { error: "body_html must be a non-empty string." };
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
        reply.status(404);
        return { error: "Template not found." };
      }

      const r = result[0]!;
      return {
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
      };
    },
  );
};

export default emailTemplatesRoutes;
