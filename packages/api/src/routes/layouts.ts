/**
 * Email templates (the Templates page): the HTML layout every email of a
 * product is sent in. Built-in templates are code (@claros/core
 * BUILTIN_LAYOUTS); custom ones are rows in email_layouts. The product's
 * settings.brand.template names the one in use: a built-in key or a
 * custom template id. Unset, brand.layout decides ("wide" or "classic").
 *
 * A template is addressed by its ref: the built-in key ("classic") or the
 * custom template's id.
 *
 *   GET    /v1/layouts                 (member)  every template, the one in use; ?previews=true adds rendered previews
 *   GET    /v1/layouts/:ref            (member)  one template with its source, findings and preview
 *   POST   /v1/layouts                 (owner, admin key "config")  create a custom template
 *   PUT    /v1/layouts/:id             (owner, admin key "config")  change a custom template
 *   DELETE /v1/layouts/:id             (owner, admin key "config")  delete a custom template not in use
 *   PUT    /v1/layouts/active          (owner, admin key "config")  { template: ref } use a template for the product
 *   POST   /v1/layouts/preview         (member)  { source, width } -> rendered sample and findings
 *   POST   /v1/layouts/assist          (owner)   template studio: one chat turn with the product's LLM
 *
 * Saving refuses templates with errors (validateLayoutSource: missing
 * {{body}} or {{compliance_footer}}, unknown placeholders, scripts, forms,
 * ...) with 422 and the findings. Client warnings never block a save.
 *
 * The assist route is the only LLM call here. It runs at authoring time
 * in the dashboard, never on the send path; its tokens count toward the
 * product's daily LLM usage.
 */
import { z } from "zod";
import { storeFor, type EmailLayoutRow } from "@claros/store";
import { decrypt, parseEncryptionKey } from "@claros/adapters";
import {
  BUILTIN_LAYOUTS,
  LAYOUT_MAX_BYTES,
  LAYOUT_WIDTHS,
  SAMPLE_BODY_HTML,
  buildShellComplianceHtml,
  builtinLayout,
  checkLayoutSource,
  isCustomLayoutRef,
  layoutKeyForBrandLayout,
  renderLayout,
  validateLayoutSource,
  type BrandSettings,
  type LayoutTemplate,
  type LayoutWidth,
} from "@claros/core";
import { OpenAICompatibleProvider, LlmProviderError, assistTemplate, type LlmProviderConfig } from "@claros/brain-oss";
import type { Db } from "../plugins/db.js";
import { RoleRouter, allowAdminKey, validatedBody } from "../http/router.js";
import { validateBody } from "../http/validate.js";

const MAX_MESSAGE = 4000;
const MAX_HISTORY = 40;

const widthSchema = z.enum(LAYOUT_WIDTHS);
const sourceSchema = z.string().max(LAYOUT_MAX_BYTES * 2);

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  width: widthSchema,
  source: sourceSchema,
  based_on: z.string().max(64).nullable().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  width: widthSchema.optional(),
  source: sourceSchema.optional(),
});

const activeSchema = z.object({ template: z.string().min(1).max(64) });

const previewSchema = z.object({ source: sourceSchema, width: widthSchema });

const assistSchema = z.object({
  source: sourceSchema,
  width: widthSchema,
  message: z.string().trim().min(1).max(MAX_MESSAGE),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(MAX_MESSAGE * 2) }))
    .max(MAX_HISTORY)
    .default([]),
});

interface ProductBrand {
  name: string;
  brand: BrandSettings;
  postalAddress: string;
  locale: string | null;
  settings: Record<string, unknown>;
}

async function loadProduct(db: Db, tenantId: string): Promise<ProductBrand | null> {
  const row = await storeFor(db).apiSettings.findTenantNameAndSettings(tenantId);
  if (!row) return null;
  const settings = (row.settings as Record<string, unknown> | null) ?? {};
  return {
    name: row.name,
    brand: (settings.brand as BrandSettings | undefined) ?? {},
    postalAddress: typeof settings.postal_address === "string" && settings.postal_address.trim() ? settings.postal_address : "Your postal address",
    locale: typeof settings.locale === "string" ? settings.locale : null,
    settings,
  };
}

/**
 * The stored template brand.template names, for wrapInShell's layout
 * input; null for built-in keys, unset values and deleted templates.
 */
export async function loadCustomLayout(db: Db, tenantId: string, ref: unknown): Promise<LayoutTemplate | null> {
  if (!isCustomLayoutRef(ref)) return null;
  const row = await storeFor(db).emailLayouts.getLayout({ tenantId, id: ref });
  return row ? { source: row.source, width: row.width === "wide" ? "wide" : "narrow" } : null;
}

/** The ref of the template the product sends with. */
export function activeLayoutRef(brand: BrandSettings): string {
  const t = brand.template;
  if (typeof t === "string" && (builtinLayout(t) || isCustomLayoutRef(t))) return t;
  return layoutKeyForBrandLayout(brand.layout);
}

/** A template rendered with the product's brand and a sample message. */
export function renderSample(template: LayoutTemplate, p: ProductBrand): string {
  return renderLayout(template, {
    bodyHtml: SAMPLE_BODY_HTML,
    brand: p.brand,
    tenantName: p.name,
    complianceFooterHtml: buildShellComplianceHtml("https://example.com/unsubscribe", p.postalAddress, p.locale),
    eyebrow: "Getting started",
    preheader: "Your workspace is ready",
  });
}

function customJson(row: EmailLayoutRow, active: string) {
  return {
    ref: row.id,
    kind: "custom" as const,
    id: row.id,
    name: row.name,
    description: row.description,
    width: row.width as LayoutWidth,
    based_on: row.basedOn,
    in_use: row.id === active,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function builtinJson(b: (typeof BUILTIN_LAYOUTS)[number], active: string) {
  return {
    ref: b.key,
    kind: "builtin" as const,
    id: null,
    name: b.name,
    description: b.description,
    width: b.width,
    based_on: null,
    in_use: b.key === active,
    created_at: null,
    updated_at: null,
  };
}

async function resolveProvider(db: Db, tenantId: string): Promise<{ ok: true; provider: OpenAICompatibleProvider } | { ok: false; status: 422 | 500; error: string }> {
  const llm = await storeFor(db).apiFlows.findActiveLlmConfig(tenantId);
  if (!llm) return { ok: false, status: 422, error: "No LLM provider is configured. Add one in Settings, AI providers to use the template studio." };
  const key = process.env.ENCRYPTION_KEY;
  if (!key) return { ok: false, status: 500, error: "ENCRYPTION_KEY not configured." };
  try {
    const config = JSON.parse(decrypt(llm.config, parseEncryptionKey(key))) as LlmProviderConfig;
    return { ok: true, provider: new OpenAICompatibleProvider(config) };
  } catch (err) {
    return { ok: false, status: 500, error: `Failed to resolve LLM provider: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export default function layoutsRoutes() {
  const r = new RoleRouter();

  r.get("/", "member", allowAdminKey("config"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const p = await loadProduct(db, tenantId);
    if (!p) return c.json({ error: "Product not found." }, 404);
    const active = activeLayoutRef(p.brand);
    const rows = await storeFor(db).emailLayouts.listLayouts(tenantId);
    const withPreview = c.req.query("previews") === "true";
    const templates = [
      ...BUILTIN_LAYOUTS.map((b) => ({ ...builtinJson(b, active), ...(withPreview ? { preview_html: renderSample(b, p) } : {}) })),
      ...rows.map((row) => ({
        ...customJson(row, active),
        ...(withPreview ? { preview_html: renderSample({ source: row.source, width: row.width as LayoutWidth }, p) } : {}),
      })),
    ];
    // A custom template in use that no longer exists falls back at send time.
    const effective = isCustomLayoutRef(active) && !rows.some((row) => row.id === active) ? layoutKeyForBrandLayout(p.brand.layout) : active;
    return c.json({ active: effective, templates });
  });

  r.put("/active", "owner", allowAdminKey("config"), validatedBody(activeSchema), async (c) => {
    const v = validateBody(c, activeSchema);
    if (!v.ok) return v.response;
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const ref = v.value.template.trim();
    if (!builtinLayout(ref)) {
      if (!isCustomLayoutRef(ref) || !(await storeFor(db).emailLayouts.getLayout({ tenantId, id: ref }))) {
        return c.json({ error: `Unknown template "${ref}".` }, 404);
      }
    }
    const p = await loadProduct(db, tenantId);
    if (!p) return c.json({ error: "Product not found." }, 404);
    await storeFor(db).apiSettings.updateTenantSettings(tenantId, { ...p.settings, brand: { ...p.brand, template: ref } });
    return c.json({ active: ref });
  });

  r.post("/preview", "member", validatedBody(previewSchema), async (c) => {
    const v = validateBody(c, previewSchema);
    if (!v.ok) return v.response;
    const p = await loadProduct(c.var.db, c.var.tenant!.id);
    if (!p) return c.json({ error: "Product not found." }, 404);
    return c.json({ html: renderSample(v.value, p), findings: checkLayoutSource(v.value.source) });
  });

  r.post("/assist", "owner", validatedBody(assistSchema), async (c) => {
    const v = validateBody(c, assistSchema);
    if (!v.ok) return v.response;
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const p = await loadProduct(db, tenantId);
    if (!p) return c.json({ error: "Product not found." }, 404);
    const resolved = await resolveProvider(db, tenantId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);

    let result;
    try {
      result = await assistTemplate(resolved.provider, {
        source: v.value.source,
        width: v.value.width,
        productName: p.brand.brand_name || p.name,
        history: v.value.history,
        message: v.value.message,
        findings: checkLayoutSource(v.value.source),
      });
    } catch (err) {
      const detail = err instanceof LlmProviderError || err instanceof Error ? err.message : String(err);
      return c.json({ error: `The AI provider did not answer: ${detail}` }, 502);
    }
    if (result.tokens > 0) {
      await storeFor(db)
        .workerProviderResolver.addLlmTokens({ tenantId, day: new Date().toISOString().slice(0, 10), tokens: result.tokens })
        .catch(() => undefined);
    }
    const source = result.source ?? v.value.source;
    return c.json({
      decision: result.decision,
      reply: result.reply,
      source: result.source,
      findings: result.findings,
      new_findings: result.newFindings,
      preview_html: result.source ? renderSample({ source, width: v.value.width }, p) : null,
    });
  });

  r.get("/:ref", "member", allowAdminKey("config"), async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const ref = c.req.param("ref")!;
    const p = await loadProduct(db, tenantId);
    if (!p) return c.json({ error: "Product not found." }, 404);
    const active = activeLayoutRef(p.brand);
    const b = builtinLayout(ref);
    if (b) {
      return c.json({ template: { ...builtinJson(b, active), source: b.source }, findings: checkLayoutSource(b.source), preview_html: renderSample(b, p) });
    }
    const row = isCustomLayoutRef(ref) ? await storeFor(db).emailLayouts.getLayout({ tenantId, id: ref }) : null;
    if (!row) return c.json({ error: "Template not found." }, 404);
    const t = { source: row.source, width: row.width as LayoutWidth };
    return c.json({ template: { ...customJson(row, active), source: row.source }, findings: checkLayoutSource(row.source), preview_html: renderSample(t, p) });
  });

  r.post("/", "owner", allowAdminKey("config"), validatedBody(createSchema), async (c) => {
    const v = validateBody(c, createSchema);
    if (!v.ok) return v.response;
    const errors = validateLayoutSource(v.value.source);
    if (errors.length > 0) return c.json({ error: "The template cannot be saved.", findings: errors }, 422);
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const row = await storeFor(db).emailLayouts.createLayout({
      tenantId,
      name: v.value.name,
      description: v.value.description ?? null,
      width: v.value.width,
      source: v.value.source,
      basedOn: v.value.based_on ?? null,
      now: new Date(),
    });
    const p = await loadProduct(db, tenantId);
    return c.json({ template: { ...customJson(row, p ? activeLayoutRef(p.brand) : ""), source: row.source }, findings: checkLayoutSource(row.source) }, 201);
  });

  r.put("/:id", "owner", allowAdminKey("config"), validatedBody(updateSchema), async (c) => {
    const v = validateBody(c, updateSchema);
    if (!v.ok) return v.response;
    const id = c.req.param("id")!;
    if (builtinLayout(id)) return c.json({ error: "Built-in templates cannot be changed. Save a copy instead (POST /v1/layouts)." }, 409);
    if (!isCustomLayoutRef(id)) return c.json({ error: "Template not found." }, 404);
    if (v.value.source !== undefined) {
      const errors = validateLayoutSource(v.value.source);
      if (errors.length > 0) return c.json({ error: "The template cannot be saved.", findings: errors }, 422);
    }
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const row = await storeFor(db).emailLayouts.updateLayout({ tenantId, id, patch: v.value, now: new Date() });
    if (!row) return c.json({ error: "Template not found." }, 404);
    const p = await loadProduct(db, tenantId);
    return c.json({ template: { ...customJson(row, p ? activeLayoutRef(p.brand) : ""), source: row.source }, findings: checkLayoutSource(row.source) });
  });

  r.delete("/:id", "owner", allowAdminKey("config"), async (c) => {
    const id = c.req.param("id")!;
    if (builtinLayout(id)) return c.json({ error: "Built-in templates cannot be deleted." }, 409);
    if (!isCustomLayoutRef(id)) return c.json({ error: "Template not found." }, 404);
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const p = await loadProduct(db, tenantId);
    if (p && p.brand.template === id) {
      return c.json({ error: "This template is in use. Choose another template for the product first." }, 409);
    }
    const deleted = await storeFor(db).emailLayouts.deleteLayout({ tenantId, id });
    if (!deleted) return c.json({ error: "Template not found." }, 404);
    return c.body(null, 204);
  });

  return r.app;
}
