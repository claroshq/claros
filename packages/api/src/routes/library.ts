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
import { RoleRouter } from "../http/router.js";
import { storeFor } from "@claros/store";
import type { Db } from "../plugins/db.js";
import {
  LIBRARY_TEMPLATES,
  LIBRARY_FLOW_WELCOME,
  type InstallResult,
} from "@claros/core";

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default function libraryRoutes() {
  const r = new RoleRouter();
  /**
   * GET /v1/library
   *
   * List available library flow sets.
   */
  r.get("/", "member", async (c) => {
    return c.json({
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
    });
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
  r.post("/install", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const store = storeFor(db).apiLibrary;

    // Check if already installed (by flow name + source = library)
    const existingId = await store.findInstalledLibraryFlow({
      tenantId,
      name: LIBRARY_FLOW_WELCOME.name,
    });

    if (existingId !== null) {
      return c.json({
        error: "Library flow already installed.",
        flowId: existingId,
      }, 409);
    }

    // Install templates (idempotent via ON CONFLICT DO NOTHING on tenant_id + slug)
    let templatesCreated = 0;
    for (const tmpl of LIBRARY_TEMPLATES) {
      if (await store.insertTemplateIfAbsent({ tenantId, template: tmpl })) {
        templatesCreated++;
      }
    }

    // Create the flow with pre-compiled plan (compile_status = 'ready')
    const flowId = await store.createLibraryFlow({
      tenantId,
      flow: LIBRARY_FLOW_WELCOME,
      compiledAt: new Date(),
    });

    const result: InstallResult = {
      flowId,
      templatesCreated,
      flowCreated: true,
    };

    return c.json({
      message: "Library flow installed successfully. Set status to 'active' to begin enrollment.",
      ...result,
    });
  });
  return r.app;
}
