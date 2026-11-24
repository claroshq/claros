/**
 * Business model templates routes - task 25.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * Registered under the /v1 prefix inside the authenticated scope.
 *
 * Endpoints:
 *   GET  /v1/templates          list available templates
 *   POST /v1/templates/:id/apply  apply a template to the calling tenant
 *
 * Applying a template:
 *   1. Validates the template identifier.
 *   2. Rejects if the tenant already has a business_model set (conflict).
 *      [impl] Double-apply is rejected: conflicting flows on the same
 *      lifecycle transition would send a contact two emails. The
 *      business_model field already records that a template was applied;
 *      no provenance column is needed. See BACKLOG.md "template switching
 *      and re-application" for the tracking item.
 *   3. Writes tenants.settings.lifecycle with the template's lifecycle config
 *      (merged over LIFECYCLE_DEFAULTS by the existing resolver).
 *   4. Writes tenants.settings.throttle with the template's throttle overrides
 *      (merged over THROTTLE_DEFAULTS by the existing resolver).
 *   5. Writes tenants.settings.brain_context with the template's brain_context
 *      string. Consumed by the decide/draft prompts as the PRODUCT CONTEXT
 *      section (context-flow.ts); the operator can edit it via
 *      PATCH /v1/settings/tenant.
 *   6. Sets tenants.business_model to the template identifier.
 *   7. Creates each template flow as a draft flow via direct DB insert.
 *      [impl] Flows are NOT compiled. The operator adds their LLM provider in
 *      Settings and compiles afterward through the existing POST /v1/flows/:id/compile
 *      path. Templates must not require credentials, because a tenant reaches
 *      onboarding before configuring a provider.
 *   8. Returns the created flows for confirmation.
 */
import { RoleRouter } from "../http/router.js";
import { eq } from "drizzle-orm";
import {
  BUSINESS_MODEL_TEMPLATES,
  BUSINESS_MODEL_TEMPLATE_LIST,
  BUSINESS_MODEL_IDS,
  type BusinessModelId,
} from "@claros/core";
import { tenants, flows } from "@claros/db/schema";
import type { Db } from "../plugins/db.js";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default function templatesRoutes() {
  const r = new RoleRouter();
  /**
   * GET /v1/templates
   * List available business model templates.
   */
  r.get("/", "member", async (c) => {
    return c.json({
      templates: BUSINESS_MODEL_TEMPLATE_LIST.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        schema_version: t.schemaVersion,
        flow_count: t.flows.length,
      })),
    });
  });

  /**
   * POST /v1/templates/:id/apply
   * Apply a business model template to the calling tenant.
   *
   * Returns 200 with { business_model, flows_created: FlowSummary[] }.
   * Returns 400 for an unknown template id.
   * Returns 409 if the tenant already has a business_model set.
   */
  r.post("/:id/apply", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const templateId = c.req.param("id") as BusinessModelId;

    // Validate template id
    if (!(BUSINESS_MODEL_IDS as readonly string[]).includes(templateId)) {
      return c.json({
        error: `Unknown template id: "${templateId}". Valid ids: ${BUSINESS_MODEL_IDS.join(", ")}.`,
      }, 400);
    }

    const template = BUSINESS_MODEL_TEMPLATES[templateId];

    // Read the current tenant row
    const tenantRows = await db
      .select({ businessModel: tenants.businessModel, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (tenantRows.length === 0) {
      return c.json({ error: "Tenant not found." }, 404);
    }

    const tenant = tenantRows[0]!;

    // Reject if a template is already applied
    if (tenant.businessModel) {
      return c.json({
        error:
          `A business model template ("${tenant.businessModel}") has already been applied to this tenant. ` +
          "Flows must be adjusted manually. See the BACKLOG for template re-application semantics.",
        applied_template: tenant.businessModel,
      }, 409);
    }

    // Build the updated settings JSONB.
    // Merge over existing settings rather than overwriting them entirely,
    // preserving any settings the tenant may have set manually (e.g. transport config).
    const existingSettings = (tenant.settings as Record<string, unknown> | null) ?? {};
    const updatedSettings: Record<string, unknown> = {
      ...existingSettings,
      lifecycle: {
        ...(existingSettings.lifecycle as Record<string, unknown> | undefined),
        ...template.lifecycle,
      },
      throttle: {
        ...(existingSettings.throttle as Record<string, unknown> | undefined),
        ...template.throttle,
      },
      brain_context: template.brain_context,
    };

    // Write the settings and business_model in a single UPDATE
    await db
      .update(tenants)
      .set({
        businessModel: template.id,
        settings: updatedSettings,
      })
      .where(eq(tenants.id, tenantId));

    // Create the template flows as drafts (no compilation).
    // Each flow gets source = 'library' to indicate it came from a template.
    const createdFlows: Array<{ id: string; name: string; status: string }> = [];

    for (const templateFlow of template.flows) {
      // Build a minimal step list so the flow is not empty.
      // The prompt_source drives compilation when the operator triggers it.
      // We create a single placeholder step; the compiler will replace it.
      const placeholderStep = {
        order: 1,
        action_type: "nurture_value",
        delay: "0d",
        window_policy: templateFlow.window_policy,
      };

      const [inserted] = await db
        .insert(flows)
        .values({
          tenantId,
          name: templateFlow.name,
          description: `Applied from "${template.name}" template.`,
          priority: 0,
          triggerType: templateFlow.trigger_type,
          triggerConfig: templateFlow.trigger_config,
          steps: [placeholderStep],
          source: "library",
          status: "draft",
          approvalMode: "require",
          flowClass: templateFlow.flow_class,
          reentryPolicy: templateFlow.reentry_policy,
          reentryCooldownDays: 30,
          promptSource: templateFlow.prompt_source,
          compiledPlan: null,
          compiledAt: null,
          compileStatus: null,
          compileError: null,
        })
        .returning({ id: flows.id, name: flows.name, status: flows.status });

      if (inserted) {
        createdFlows.push({ id: inserted.id, name: inserted.name, status: inserted.status ?? "draft" });
      }
    }

    return c.json({
      business_model: template.id,
      template_name: template.name,
      flows_created: createdFlows,
    });
  });
  return r.app;
}
