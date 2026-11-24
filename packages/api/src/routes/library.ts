/**
 * Library flows routes - install pre-built flows with templates.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * Registered under the /v1 prefix inside the authenticated scope.
 *
 * Endpoints:
 *   GET   /v1/library              list available library flows
 *   POST  /v1/library/install      install the welcome flow set for the tenant
 *
 * Installing creates templates and a flow in "draft" status. The user must
 * explicitly activate the flow to start enrollment. No LLM is required.
 */
import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "../plugins/db.js";
import {
  LIBRARY_TEMPLATES,
  LIBRARY_FLOW_WELCOME,
  type InstallResult,
} from "@claros/core";

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const libraryRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /v1/library
   *
   * List available library flow sets.
   */
  app.get("/", { config: { minRole: "member" } }, async () => {
    return {
      flows: [
        {
          id: "welcome-onboarding",
          name: LIBRARY_FLOW_WELCOME.name,
          description: LIBRARY_FLOW_WELCOME.description,
          emails: LIBRARY_FLOW_WELCOME.steps.length,
          trigger: "signed_up event",
          templates: LIBRARY_TEMPLATES.map((t) => ({
            slug: t.slug,
            name: t.name,
            subject: t.subject,
          })),
        },
      ],
    };
  });

  /**
   * POST /v1/library/install
   *
   * Install the welcome library flow and its templates for the calling tenant.
   * Templates use ON CONFLICT DO NOTHING (idempotent on slug).
   * The flow is created in "draft" status with compile_status = "ready"
   * (pre-compiled plan, no LLM needed).
   *
   * Returns 200 with the created flow ID and template count.
   * Returns 409 if the flow already exists for this tenant (by name + source).
   */
  app.post("/install", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    // Check if already installed (by flow name + source = library)
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id FROM flows
      WHERE tenant_id = ${tenantId}
        AND name = ${LIBRARY_FLOW_WELCOME.name}
        AND source = 'library'
      LIMIT 1
    `);

    if (existing.rows.length > 0) {
      reply.status(409);
      return {
        error: "Library flow already installed.",
        flowId: existing.rows[0]!.id,
      };
    }

    // Install templates (idempotent via ON CONFLICT DO NOTHING on tenant_id + slug)
    let templatesCreated = 0;
    for (const tmpl of LIBRARY_TEMPLATES) {
      const result = await db.execute<{ id: string }>(sql`
        INSERT INTO templates (tenant_id, name, slug, subject, body_html, body_text, variables, category)
        VALUES (
          ${tenantId},
          ${tmpl.name},
          ${tmpl.slug},
          ${tmpl.subject},
          ${tmpl.bodyHtml},
          ${tmpl.bodyText},
          ${sql`ARRAY[${sql.join(tmpl.variables.map(v => sql`${v}`), sql`, `)}]::text[]`},
          ${tmpl.category}
        )
        ON CONFLICT (tenant_id, slug) DO NOTHING
        RETURNING id
      `);
      if (result.rows.length > 0) {
        templatesCreated++;
      }
    }

    // Create the flow with pre-compiled plan (compile_status = 'ready')
    const flowResult = await db.execute<{ id: string }>(sql`
      INSERT INTO flows (
        tenant_id, name, description, trigger_type, trigger_config, steps,
        source, status, approval_mode, flow_class, reentry_policy,
        reentry_cooldown_days, priority, compiled_plan, compile_status, compiled_at
      )
      VALUES (
        ${tenantId},
        ${LIBRARY_FLOW_WELCOME.name},
        ${LIBRARY_FLOW_WELCOME.description},
        ${LIBRARY_FLOW_WELCOME.triggerType},
        ${JSON.stringify(LIBRARY_FLOW_WELCOME.triggerConfig)}::jsonb,
        ${JSON.stringify(LIBRARY_FLOW_WELCOME.steps)}::jsonb,
        ${LIBRARY_FLOW_WELCOME.source},
        'draft',
        ${LIBRARY_FLOW_WELCOME.approvalMode},
        ${LIBRARY_FLOW_WELCOME.flowClass},
        ${LIBRARY_FLOW_WELCOME.reentryPolicy},
        ${LIBRARY_FLOW_WELCOME.reentryCooldownDays},
        ${LIBRARY_FLOW_WELCOME.priority},
        ${JSON.stringify(LIBRARY_FLOW_WELCOME.compiledPlan)}::jsonb,
        'ready',
        ${new Date()}
      )
      RETURNING id
    `);

    const flowId = flowResult.rows[0]!.id;

    const result: InstallResult = {
      flowId,
      templatesCreated,
      flowCreated: true,
    };

    return {
      message: "Library flow installed successfully. Set status to 'active' to begin enrollment.",
      ...result,
    };
  });
};

export default libraryRoutes;
