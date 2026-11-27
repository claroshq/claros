/**
 * Settings routes - transport configuration, LLM configuration, and tenant settings.
 *
 * All routes require session-cookie authentication (dashboard operator scope).
 * Registered under the /v1 prefix inside the authenticated scope.
 *
 * Transport endpoints:
 *   PUT  /v1/settings/transport
 *     Write or replace the active transport configuration for the calling tenant.
 *     Encrypts the credential and webhook secret with the envelope from
 *     @claros/adapters before storing. Deactivates any previous active row
 *     for this tenant in the same operation (upsert via deactivate + insert).
 *     Body: { provider, from_email, from_name?, api_key, webhook_secret?, daily_limit? }
 *
 *   GET  /v1/settings/transport
 *     Read the active transport configuration. Never returns api_key or
 *     webhook_secret in any form.
 *     Response: { id, provider, from_email, from_name, daily_limit,
 *                 dkim_verified, is_active, created_at } or null.
 *
 * LLM endpoints:
 *   PUT  /v1/settings/llm
 *     Write or replace the active LLM provider configuration for the calling tenant.
 *     A person supplies provider + api_key; base_url and model default per
 *     provider (llm-providers.ts) and are accepted only as overrides. The key
 *     is verified against the provider before anything is stored. Encrypts
 *     api_key, base_url, model (and optional embedding_model) with the same
 *     envelope as transport. Deactivates any previous active row for this
 *     tenant (deactivate + insert pattern, same as transport).
 *     Body: { provider, api_key?, base_url?, model?, embedding_model? }
 *
 *   GET  /v1/settings/llm
 *     Read the active LLM configuration. Never returns api_key in any form.
 *     Response: { id, provider, model, base_url, embedding_model,
 *                 is_active, created_at } or null.
 *     The effective model/base_url are returned so the dashboard can show
 *     what the install will actually use; the api_key never leaves the
 *     envelope.
 *
 * Tenant settings endpoints:
 *   GET  /v1/settings/tenant
 *     Read current tenant settings (name, slug, plan, postal_address).
 *
 *   PATCH /v1/settings/tenant
 *     Update tenant settings. Currently supports postal_address, brain_context,
 *     and brand. Other keys in tenants.settings (lifecycle, throttle)
 *     are managed by the templates route; this endpoint merges
 *     only the fields it owns to prevent clobbering template-applied settings.
 *     Body: { postal_address?, brain_context?, brand? }
 *
 * Encryption pattern:
 *   Follows the same convention as provider-resolver.ts / transport-resolver.ts.
 *   ENCRYPTION_KEY env var -> parseEncryptionKey -> encrypt(JSON.stringify(creds), key).
 *   On read: credentials are decrypted at use time only (resolver). This endpoint
 *   never decrypts on read - it returns only non-sensitive metadata columns.
 *
 *   [impl] Per-tenant credentials (LLM and transport API keys) live encrypted in the
 *   database. Only process-level keys stay in the environment: ENCRYPTION_KEY (decrypts
 *   the database) and UNSUBSCRIBE_SIGNING_KEY (belongs to the installation). No per-tenant
 *   credential should ever be in an environment variable.
 *
 * Provider validation:
 *   The KNOWN_PROVIDERS list matches what transport-resolver.ts implements or
 *   explicitly acknowledges. Storing an unimplemented provider is allowed because
 *   the resolver documents the safe fallback: null return, messages stay approved,
 *   no operator action required when the provider ships. Validation only rejects
 *   values that are clearly not a known provider identifier.
 */
import { z } from "zod";
import { storeFor } from "@claros/store";
import { encrypt, decrypt, parseEncryptionKey, resolveTransportAdapter, SmtpTransportAdapter } from "@claros/adapters";
import { wrapInShell, wrapInTextShell, buildShellComplianceHtml, buildShellComplianceText, resolveThrottleConfig, BRAND_LAYOUTS, BUILTIN_LAYOUTS, builtinLayout, isCustomLayoutRef, type BrandSettings } from "@claros/core";
import {
  KNOWN_LLM_PROVIDERS,
  isKnownLlmProvider,
  resolveLlmConfig,
  verifyLlmCredentials,
} from "../llm-providers.js";
import type { Db } from "../plugins/db.js";
import { RoleRouter, validatedBody } from "../http/router.js";
import { loadTransportSetup, registerTransportRoutes, saveRouting, sendTestEmail } from "./settings-transports.js";
import { registerEmbeddingRoutes } from "./settings-embeddings.js";
import { validateBody, coerceInt, coerceBool, coerceString } from "../http/validate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known provider identifiers. "resend" provides an HTTP API with webhook
 * feedback. "smtp" provides generic SMTP delivery (works with any provider
 * including Amazon SES SMTP endpoints). SES was removed as a separate option
 * because its SMTP endpoint is fully served by the SMTP adapter, and its API
 * mode (SNS webhooks) is not implemented.
 */
const KNOWN_PROVIDERS = ["resend", "smtp"] as const;
type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

function isKnownProvider(v: string): v is KnownProvider {
  return (KNOWN_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Maximum length for tenants.settings.brain_context.
 *
 * [impl] Unvalidated starting value. brain_context is injected into every
 * decide/draft prompt as a protected section (never dropped under budget
 * pressure - see context-budget.ts). At ~4 chars/token, 4000 chars costs
 * ~1000 tokens against a 4000-token context budget (MAX_CONTEXT_TOKENS).
 * That is the largest share a permanently present section can reasonably
 * take while leaving room for contact, lifecycle, and KB sections.
 */
export const BRAIN_CONTEXT_MAX_CHARS = 4_000;

const DAYS_OF_WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

/*
 * Same rules as the v0.6 JSON schemas: required fields, types, formats and
 * bounds as declared there; unknown properties are removed and scalars are
 * coerced the way v0.6 did (see validate.ts). Messages follow v0.6 wording
 * ("must be <= 65535", `must match format "email"`).
 */

/** The "email" format v0.6 applied (ajv-formats, full mode). */
const EMAIL_FORMAT =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/** HH:MM pattern for the throttle send window. */
const HH_MM_PATTERN = "^([01]?[0-9]|2[0-3]):[0-5][0-9]$";

/** JSON schema "number" with v0.6 coercion ("1.5" -> 1.5, true -> 1). */
const coerceNumber = () =>
  z.preprocess(
    (v) =>
      typeof v === "string" && v !== "" && !Number.isNaN(Number(v))
        ? Number(v)
        : typeof v === "boolean"
          ? Number(v)
          : v,
    z.number(),
  );

/** { type: "string", minLength: 1 } */
const nonEmptyString = () =>
  coerceString().pipe(z.string().min(1, "must NOT have fewer than 1 characters"));

/** { type: "integer", minimum, maximum? } */
const boundedInt = (min: number, max?: number) => {
  let n = z.number().min(min, `must be >= ${min}`);
  if (max !== undefined) n = n.max(max, `must be <= ${max}`);
  return coerceInt().pipe(n);
};

/** { type: ["string", "null"] } */
const nullableString = () => coerceString().nullable();

/** { type: ["number", "null"] }; v0.6 coerced "" to null for this type. */
const nullableNumber = () => z.preprocess((v) => (v === "" ? null : v), coerceNumber().nullable());

/** { type: "string", enum } */
const enumOf = <T extends [string, ...string[]]>(values: T) =>
  z.enum(values, { errorMap: () => ({ message: "must be equal to one of the allowed values" }) });

/** { type: "string", pattern } */
const patternString = (pattern: string) =>
  coerceString().pipe(z.string().regex(new RegExp(pattern, "u"), `must match pattern "${pattern}"`));

const transportBodySchema = z.object({
  provider: coerceString(),
  from_email: coerceString().pipe(z.string().regex(EMAIL_FORMAT, 'must match format "email"')),
  from_name: coerceString().optional(),
  api_key: nonEmptyString().optional(),
  webhook_secret: coerceString().optional(),
  host: nonEmptyString().optional(),
  port: boundedInt(1, 65535).optional(),
  secure: coerceBool().optional(),
  username: coerceString().optional(),
  password: coerceString().optional(),
  reject_unauthorized: coerceBool().optional(),
  daily_limit: boundedInt(1).optional(),
});

const llmBodySchema = z.object({
  provider: coerceString(),
  api_key: coerceString().optional(),
  base_url: nonEmptyString().optional(),
  model: nonEmptyString().optional(),
  embedding_model: coerceString().optional(),
});

const tenantPatchBodySchema = z.object({
  postal_address: coerceString().optional(),
  brain_context: nullableString().optional(),
  brand: z
    .object(
      {
        brand_name: nullableString().optional(),
        logo_url: nullableString().optional(),
        logo_dark_url: nullableString().optional(),
        logo_height: nullableNumber().optional(),
        accent_color: nullableString().optional(),
        footer_text: nullableString().optional(),
        reply_to: nullableString().optional(),
        layout: nullableString().optional(),
        template: nullableString().optional(),
      },
      { invalid_type_error: "must be object" },
    )
    .optional(),
});

const throttleBodySchema = z.object({
  max_emails_per_user_per_day: boundedInt(0, 100).optional(),
  max_emails_per_user_per_week: boundedInt(0, 500).optional(),
  min_interval_between_emails_hours: coerceNumber()
    .pipe(z.number().min(0, "must be >= 0").max(168, "must be <= 168"))
    .optional(),
  send_window_start: patternString(HH_MM_PATTERN).optional(),
  send_window_end: patternString(HH_MM_PATTERN).optional(),
  send_window_days: z.array(enumOf([...DAYS_OF_WEEK]), { invalid_type_error: "must be array" }).optional(),
  send_window_timezone: enumOf(["contact_local", "tenant_fixed"]).optional(),
  tenant_timezone: coerceString().optional(),
  batch_size_per_tick: boundedInt(1, 100).optional(),
});

const testEmailBodySchema = z.object({
  to: coerceString(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default function settingsRoutes() {
  const r = new RoleRouter();
  registerTransportRoutes(r);
  registerEmbeddingRoutes(r);
  // -------------------------------------------------------------------------
  // PUT /v1/settings/transport
  // -------------------------------------------------------------------------

  /**
   * PUT /v1/settings/transport
   * Write or replace the active transport configuration.
   *
   * Encryption requires ENCRYPTION_KEY to be set. Returns 503 if absent.
   * Returns 400 for unknown provider or missing required fields.
   *
   * The operation is: deactivate all existing active rows for this tenant,
   * then insert a fresh row. This keeps a history of previous configs
   * (is_active = false) while ensuring only one active row per tenant.
   */
  r.put(
    "/transport",
    "owner",
    validatedBody(transportBodySchema),
    async (c) => {
      const v = validateBody(c, transportBodySchema);
      if (!v.ok) return v.response;
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;
      const {
        provider, from_email, from_name, api_key, webhook_secret, daily_limit,
        host, port, secure, username, password, reject_unauthorized,
      } = v.value;

      // Validate provider
      if (!isKnownProvider(provider)) {
        return c.json({
          error: `Unknown provider: "${provider}". Valid values: ${KNOWN_PROVIDERS.join(", ")}.`,
        }, 400);
      }

      // Provider-specific field validation
      if (provider === "resend") {
        if (!api_key) {
          return c.json({ error: "api_key is required for Resend." }, 400);
        }
      } else if (provider === "smtp") {
        if (!host || port === undefined) {
          return c.json({ error: "host and port are required for SMTP." }, 400);
        }
      }

      // Require ENCRYPTION_KEY
      const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
      if (!encryptionKeyEnv) {
        return c.json({
          error:
            "ENCRYPTION_KEY is not configured. " +
            "Set ENCRYPTION_KEY before storing transport credentials.",
        }, 503);
      }

      let key: Buffer;
      try {
        key = parseEncryptionKey(encryptionKeyEnv);
      } catch (err) {
        return c.json({
          error: `ENCRYPTION_KEY is invalid: ${err instanceof Error ? err.message : String(err)}`,
        }, 503);
      }

      // Build credential object based on provider
      let credentials: Record<string, unknown>;
      if (provider === "smtp") {
        credentials = {
          host,
          port,
          secure: secure ?? (port === 465),
          username: username || undefined,
          password: password || undefined,
          rejectUnauthorized: reject_unauthorized ?? true,
        };
      } else {
        // Resend
        credentials = { apiKey: api_key };
        if (webhook_secret !== undefined && webhook_secret !== "") {
          credentials.webhookSecret = webhook_secret;
        }
      }

      const encryptedConfig = encrypt(JSON.stringify(credentials), key);

      // Verify credentials before storing (SMTP: EHLO + AUTH check)
      if (provider === "smtp") {
        const testAdapter = new SmtpTransportAdapter({
          host: host!,
          port: port!,
          secure: secure ?? (port === 465),
          username: username || undefined,
          password: password || undefined,
          rejectUnauthorized: reject_unauthorized ?? true,
        });
        try {
          const verification = await testAdapter.verify();
          if (!verification.ok) {
            return c.json({
              error: `SMTP verification failed: ${verification.error}. Nothing was stored.`,
            }, 422);
          }
        } finally {
          testAdapter.close();
        }
      }

      // Deactivate existing active rows, then insert a fresh one.
      // Both operations run sequentially in application code. They are not
      // wrapped in an explicit transaction because:
      //   - A window between deactivate and insert leaves the tenant with no
      //     active config, which is safe (drain skips, no messages lost).
      //   - Postgres does not have serializable default isolation anyway;
      //     the deactivate-then-insert pattern is idiomatic here.
      //   - If insert fails, the tenant is left with no active config.
      //     The operator retries the PUT. This is the safer failure mode
      //     vs. wrapping in a transaction and rolling back the deactivation.
      //
      // With several transports (G26) this endpoint replaces the default
      // transport only; other transports stay active. A product with one
      // transport behaves exactly as before.
      const setup = await loadTransportSetup(db, tenantId);
      if (setup.active.length <= 1 || setup.defaultTransport === null) {
        await storeFor(db).apiSettings.deactivateActiveTransportConfigs(tenantId);
      } else {
        await storeFor(db).apiSettings.deactivateTransport({ tenantId, id: setup.defaultTransport.id });
      }

      const inserted = await storeFor(db).apiSettings.insertActiveTransportConfig({
        tenantId,
        provider,
        encryptedConfig,
        fromEmail: from_email,
        fromName: from_name ?? null,
        dailyLimit: daily_limit ?? null,
      });

      // Keep routing pointing at the replacement: other transports remain, so
      // the new row must be named as the default explicitly.
      if (setup.active.length > 1 && setup.defaultTransport !== null && inserted) {
        const replaced = setup.defaultTransport.id;
        const routing = { ...setup.routing, default: inserted.id };
        if (routing.transactional === replaced) routing.transactional = inserted.id;
        await saveRouting(db, tenantId, setup.settings, routing);
      }

      return c.json({
        transport: {
          id: inserted!.id,
          provider: inserted!.provider,
          from_email: inserted!.fromEmail,
          from_name: inserted!.fromName,
          daily_limit: inserted!.dailyLimit,
          dkim_verified: inserted!.dkimVerified,
          is_active: inserted!.isActive,
          created_at: inserted!.createdAt,
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/settings/transport
  // -------------------------------------------------------------------------

  /**
   * GET /v1/settings/transport
   * Read the active transport configuration without credentials.
   *
   * Returns { transport: {...} } if an active config exists, or { transport: null }.
   * The response never includes api_key, webhook_secret, or the raw config envelope
   * in any form - not masked, not partially shown.
   */
  r.get("/transport", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    // The default transport (G26): routing.default, else the oldest active one.
    const row = (await loadTransportSetup(db, tenantId)).defaultTransport;

    if (!row) {
      return c.json({ transport: null });
    }

    return c.json({
      transport: {
        id: row.id,
        provider: row.provider,
        from_email: row.fromEmail,
        from_name: row.fromName,
        daily_limit: row.dailyLimit,
        dkim_verified: row.dkimVerified,
        is_active: row.isActive,
        created_at: row.createdAt,
      },
    });
  });

  // -------------------------------------------------------------------------
  // PUT /v1/settings/llm
  // -------------------------------------------------------------------------

  /**
   * PUT /v1/settings/llm
   * Write or replace the active LLM provider configuration.
   *
   * A person supplies a provider and an API key. base_url and model are
   * product decisions with per-provider defaults (see llm-providers.ts);
   * they are accepted here only as overrides. A custom endpoint has no
   * defaults, so base_url and model are required for provider "custom".
   *
   * The credentials are verified against the provider before anything is
   * stored (cheapest real call: a 1-token chat completion, single attempt,
   * 10s timeout). A failed verification returns 422 with the provider's
   * own message and stores nothing.
   *
   * Encryption requires ENCRYPTION_KEY to be set. Returns 503 if absent.
   * Returns 400 for unknown provider or a missing value with no default.
   *
   * The operation is: deactivate all existing active rows for this tenant,
   * then insert a fresh row. Same pattern as PUT /v1/settings/transport.
   *
   * The entire credential object (api_key, base_url, model, embedding_model)
   * is encrypted together. Read-back returns the effective non-secret values
   * (base_url, model, embedding_model) but never the api_key.
   *
   * embedding_model is optional; if omitted, the embedding client defaults to
   * "text-embedding-3-small". Setting it here controls which model is used for
   * KB entry indexing and similarity search queries.
   */
  r.put(
    "/llm",
    "owner",
    validatedBody(llmBodySchema),
    async (c) => {
      const v = validateBody(c, llmBodySchema);
      if (!v.ok) return v.response;
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;
      const { provider, api_key, base_url, model, embedding_model } = v.value;

      // Validate provider
      if (!isKnownLlmProvider(provider)) {
        return c.json({
          error: `Unknown provider: "${provider}". Valid values: ${KNOWN_LLM_PROVIDERS.join(", ")}.`,
        }, 400);
      }

      // Apply per-provider defaults; overrides win when present.
      const resolved = resolveLlmConfig(provider, {
        apiKey: api_key,
        baseUrl: base_url,
        model,
        embeddingModel: embedding_model,
      });
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 400);
      }
      const effective = resolved.config;

      // Require ENCRYPTION_KEY
      const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
      if (!encryptionKeyEnv) {
        return c.json({
          error:
            "ENCRYPTION_KEY is not configured. " +
            "Set ENCRYPTION_KEY before storing LLM credentials.",
        }, 503);
      }

      let key: Buffer;
      try {
        key = parseEncryptionKey(encryptionKeyEnv);
      } catch (err) {
        return c.json({
          error: `ENCRYPTION_KEY is invalid: ${err instanceof Error ? err.message : String(err)}`,
        }, 503);
      }

      // Verify the credentials before storing anything. A wrong key stored
      // silently surfaces hours later as failed compiles and stuck messages;
      // here the provider's own answer comes back immediately.
      const verification = await verifyLlmCredentials({
        baseUrl: effective.baseUrl,
        apiKey: effective.apiKey,
        model: effective.model,
      });
      if (!verification.ok) {
        const prefix =
          verification.kind === "http"
            ? `${effective.baseUrl} rejected the credentials (HTTP ${verification.status})`
            : verification.kind === "timeout"
              ? `${effective.baseUrl} did not answer within 10 seconds`
              : `${effective.baseUrl} could not be reached`;
        const said = verification.detail !== "" ? `: ${verification.detail}` : "";
        return c.json({
          error: `${prefix}${said}. Nothing was stored.`,
          verification: {
            ok: false,
            kind: verification.kind,
            status: verification.status,
            detail: verification.detail,
          },
        }, 422);
      }

      // Build credential object and encrypt it.
      // The entire config - api_key, base_url, model, and embedding_model - is
      // encrypted together. None of these fields are stored in plaintext columns
      // because they all identify the tenant's provider and must be kept confidential.
      // embedding_model is stored only when the operator chose one; when absent
      // the embedding client applies its own default at use time.
      const credentials: {
        apiKey: string;
        baseUrl: string;
        model: string;
        embedding_model?: string;
      } = {
        apiKey: effective.apiKey,
        baseUrl: effective.baseUrl,
        model: effective.model,
      };
      if (effective.overridden.includes("embedding_model") && effective.embeddingModel !== null) {
        credentials.embedding_model = effective.embeddingModel;
      }

      const encryptedConfig = encrypt(JSON.stringify(credentials), key);

      // Deactivate existing active rows, then insert a fresh one.
      // Same pattern as transport: safer than a transaction because the
      // failure mode (no active config) is recoverable with a retry PUT.
      await storeFor(db).apiSettings.deactivateActiveLlmConfigs(tenantId);

      const inserted = await storeFor(db).apiSettings.insertActiveLlmConfig({
        tenantId,
        provider,
        encryptedConfig,
      });

      return c.json({
        llm: {
          id: inserted!.id,
          provider: inserted!.provider,
          model: effective.model,
          base_url: effective.baseUrl,
          embedding_model: effective.embeddingModel,
          is_active: inserted!.isActive,
          created_at: inserted!.createdAt,
        },
        verification: { ok: true },
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/settings/llm
  // -------------------------------------------------------------------------

  /**
   * GET /v1/settings/llm
   * Read the active LLM configuration without the API key.
   *
   * Returns { llm: {...} } if an active config exists, or { llm: null }.
   * The response includes the effective model, base_url, and embedding_model
   * so the dashboard can show what the install will actually use; it never
   * includes the api_key. Reading these values requires decrypting the
   * envelope, so when ENCRYPTION_KEY is absent or the envelope is
   * undecryptable the endpoint still answers with model/base_url/
   * embedding_model set to null rather than failing the settings screen.
   */
  r.get("/llm", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const row = await storeFor(db).apiSettings.findActiveLlmConfig(tenantId);

    if (!row) {
      return c.json({ llm: null });
    }


    // Decrypt for the non-secret effective values only. The api_key is
    // parsed out of the envelope and deliberately never copied to the
    // response object.
    let model: string | null = null;
    let baseUrl: string | null = null;
    let embeddingModel: string | null = null;
    const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
    if (encryptionKeyEnv) {
      try {
        const key = parseEncryptionKey(encryptionKeyEnv);
        const decrypted = JSON.parse(decrypt(row.config, key)) as {
          baseUrl?: string;
          model?: string;
          embedding_model?: string;
        };
        model = decrypted.model ?? null;
        baseUrl = decrypted.baseUrl ?? null;
        embeddingModel = decrypted.embedding_model ?? null;
      } catch {
        // Undecryptable envelope (key rotation, manual edit). Metadata below
        // is still accurate; the dashboard shows the effective values as
        // unknown rather than breaking the settings screen.
      }
    }

    return c.json({
      llm: {
        id: row.id,
        provider: row.provider,
        model,
        base_url: baseUrl,
        embedding_model: embeddingModel,
        is_active: row.isActive,
        created_at: row.createdAt,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/settings/tenant
  // -------------------------------------------------------------------------

  /**
   * GET /v1/settings/tenant
   * Read current tenant metadata and settings.
   *
   * Returns name, slug, plan, and the operator-configurable settings keys:
   * postal_address, brand, brain_context. Does not return lifecycle/throttle
   * because those are managed by the templates route.
   */
  r.get("/tenant", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const row = await storeFor(db).apiSettings.findTenant(tenantId);

    if (!row) {
      return c.json({ error: "Tenant not found." }, 404);
    }

    const settings = (row.settings as Record<string, unknown> | null) ?? {};
    const brand = (settings.brand as Record<string, unknown> | undefined) ?? {};

    return c.json({
      tenant: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        plan: row.plan,
        postal_address: (settings.postal_address as string | undefined) ?? null,
        brain_context: (settings.brain_context as string | undefined) ?? null,
        brand: {
          brand_name: (brand.brand_name as string | undefined) ?? null,
          logo_url: (brand.logo_url as string | undefined) ?? null,
          logo_dark_url: (brand.logo_dark_url as string | undefined) ?? null,
          logo_height: (brand.logo_height as number | undefined) ?? null,
          accent_color: (brand.accent_color as string | undefined) ?? null,
          footer_text: (brand.footer_text as string | undefined) ?? null,
          reply_to: (brand.reply_to as string | undefined) ?? null,
          layout: (brand.layout as string | undefined) ?? null,
          template: (brand.template as string | undefined) ?? null,
        },
        created_at: row.createdAt,
      },
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /v1/settings/tenant
  // -------------------------------------------------------------------------

  /**
   * PATCH /v1/settings/tenant
   * Update operator-managed tenant settings.
   *
   * Supports: postal_address, brain_context, brand (object with brand_name,
   * logo_url, logo_dark_url, logo_height, accent_color, footer_text, reply_to, layout).
   * Merges over existing settings - does not overwrite lifecycle/throttle
   * that the templates route writes.
   *
   * brain_context is the tenant-level product description injected into every
   * decide/draft prompt (anti-hallucination anchor, protected from budget
   * truncation). Applying a business model template seeds it; this endpoint
   * is how the operator edits or replaces that seed. Capped at
   * BRAIN_CONTEXT_MAX_CHARS. null or an empty/whitespace string clears it.
   *
   * Returns 400 if postal_address is an empty string after trimming (callers
   * that want to clear the address must supply a non-empty replacement; clearing
   * would block the drain and is likely a mistake).
   */
  r.patch(
    "/tenant",
    "owner",
    validatedBody(tenantPatchBodySchema),
    async (c) => {
      const v = validateBody(c, tenantPatchBodySchema);
      if (!v.ok) return v.response;
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;
      const { postal_address, brain_context, brand } = v.value;

      // Nothing to update
      if (postal_address === undefined && brain_context === undefined && brand === undefined) {
        return c.json({
          error: "No updatable fields provided. Supported: postal_address, brain_context, brand.",
        }, 400);
      }

      // Validate postal_address if provided
      if (postal_address !== undefined && postal_address.trim().length === 0) {
        return c.json({
          error:
            "postal_address must be a non-empty string. " +
            "An empty postal address would block outgoing mail (CAN-SPAM compliance).",
        }, 400);
      }

      // Validate brain_context if provided
      if (
        brain_context !== undefined &&
        brain_context !== null &&
        brain_context.length > BRAIN_CONTEXT_MAX_CHARS
      ) {
        return c.json({
          error:
            `brain_context must be at most ${BRAIN_CONTEXT_MAX_CHARS} characters. ` +
            "It is injected into every LLM prompt; longer texts blow the context budget.",
        }, 400);
      }

      // Validate brand fields if provided
      if (brand) {
        for (const key of ["logo_url", "logo_dark_url"] as const) {
          const value = brand[key];
          if (value === undefined || value === null) continue;
          // Must be a valid absolute URL (http or https)
          try {
            const url = new URL(value);
            if (!["http:", "https:"].includes(url.protocol)) {
              return c.json({ error: `brand.${key} must be an http or https URL.` }, 400);
            }
          } catch {
            return c.json({ error: `brand.${key} must be a valid URL.` }, 400);
          }
        }
        if (brand.accent_color !== undefined && brand.accent_color !== null) {
          if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(brand.accent_color)) {
            return c.json({ error: "brand.accent_color must be a valid hex color (e.g. #2563eb)." }, 400);
          }
        }
        if (brand.reply_to !== undefined && brand.reply_to !== null) {
          // Basic email format check
          if (!brand.reply_to.includes("@") || brand.reply_to.trim().length < 3) {
            return c.json({ error: "brand.reply_to must be a valid email address." }, 400);
          }
        }
        if (brand.logo_height !== undefined && brand.logo_height !== null) {
          if (brand.logo_height < 16 || brand.logo_height > 64) {
            return c.json({ error: "brand.logo_height must be between 16 and 64." }, 400);
          }
        }
        if (brand.layout !== undefined && brand.layout !== null) {
          if (!(BRAND_LAYOUTS as readonly string[]).includes(brand.layout.trim())) {
            return c.json({ error: `brand.layout must be one of: ${BRAND_LAYOUTS.join(", ")}.` }, 400);
          }
        }
        if (brand.template !== undefined && brand.template !== null) {
          const ref = brand.template.trim();
          const known = builtinLayout(ref) !== null
            || (isCustomLayoutRef(ref) && (await storeFor(db).emailLayouts.getLayout({ tenantId, id: ref })) !== null);
          if (!known) {
            return c.json({ error: `brand.template must be a built-in template (${BUILTIN_LAYOUTS.map((b) => b.key).join(", ")}) or the id of one of the product's templates.` }, 400);
          }
        }
      }

      // Read current settings, merge, write back
      const tenantRow = await storeFor(db).apiSettings.findTenantSettings(tenantId);

      if (!tenantRow) {
        return c.json({ error: "Tenant not found." }, 404);
      }

      const existing = (tenantRow.settings as Record<string, unknown> | null) ?? {};
      const updated: Record<string, unknown> = { ...existing };

      if (postal_address !== undefined) {
        updated.postal_address = postal_address.trim();
      }

      if (brain_context !== undefined) {
        // null or empty/whitespace string clears the field (absent = not
        // injected into prompts). Non-empty values are stored trimmed.
        const trimmed = brain_context === null ? "" : brain_context.trim();
        if (trimmed.length === 0) {
          delete updated.brain_context;
        } else {
          updated.brain_context = trimmed;
        }
      }

      if (brand !== undefined) {
        const existingBrand = (existing.brand as Record<string, unknown> | undefined) ?? {};
        const mergedBrand: Record<string, unknown> = { ...existingBrand };

        // Merge brand fields: null means "clear this field"
        for (const [key, value] of Object.entries(brand)) {
          if (value === null) {
            delete mergedBrand[key];
          } else if (value !== undefined) {
            mergedBrand[key] = typeof value === "string" ? value.trim() : value;
          }
        }
        updated.brand = mergedBrand;
      }

      await storeFor(db).apiSettings.updateTenantSettings(tenantId, updated);

      const finalBrand = (updated.brand as Record<string, unknown> | undefined) ?? {};

      return c.json({
        tenant: {
          postal_address: (updated.postal_address as string | undefined) ?? null,
          brain_context: (updated.brain_context as string | undefined) ?? null,
          brand: {
            brand_name: (finalBrand.brand_name as string | undefined) ?? null,
            logo_url: (finalBrand.logo_url as string | undefined) ?? null,
            logo_dark_url: (finalBrand.logo_dark_url as string | undefined) ?? null,
            logo_height: (finalBrand.logo_height as number | undefined) ?? null,
            accent_color: (finalBrand.accent_color as string | undefined) ?? null,
            footer_text: (finalBrand.footer_text as string | undefined) ?? null,
            reply_to: (finalBrand.reply_to as string | undefined) ?? null,
            layout: (finalBrand.layout as string | undefined) ?? null,
            template: (finalBrand.template as string | undefined) ?? null,
          },
        },
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/settings/test-email
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Throttle settings
  // -------------------------------------------------------------------------

  /**
   * GET /v1/settings/throttle
   * Read the current throttle configuration.
   * Returns the resolved config (defaults filled in for missing fields).
   */
  r.get("/throttle", "member", async (c) => {
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const tenantRow = await storeFor(db).apiSettings.findTenantSettings(tenantId);

    if (!tenantRow) {
      return c.json({ error: "Tenant not found." });
    }

    const settings = (tenantRow.settings as Record<string, unknown> | null) ?? {};
    const config = resolveThrottleConfig(settings.throttle ?? null);

    return c.json({ throttle: config });
  });

  /**
   * PUT /v1/settings/throttle
   * Write throttle configuration. Merges over existing settings.
   *
   * Exposed controls with bounds:
   *   - max_emails_per_user_per_day: 0-100 (floor: 0 means no daily cap)
   *   - max_emails_per_user_per_week: 0-500 (floor: 0 means no weekly cap)
   *   - min_interval_between_emails_hours: 0-168 (floor: 0 means no minimum gap)
   *   - send_window_start: HH:MM format (00:00-23:59)
   *   - send_window_end: HH:MM format (must be after start)
   *   - send_window_days: array of mon-sun (at least one required)
   *   - send_window_timezone: "contact_local" | "tenant_fixed"
   *   - tenant_timezone: IANA timezone string (required if timezone is "tenant_fixed")
   *   - batch_size_per_tick: 1-100
   *
   * Internal (not exposed):
   *   - drain_interval_minutes: fixed at 15 min (pg-boss cron limitation)
   *   - critical_bypass_throttle: always true (critical emails always bypass)
   */
  r.put(
    "/throttle",
    "owner",
    validatedBody(throttleBodySchema),
    async (c) => {
      const v = validateBody(c, throttleBodySchema);
      if (!v.ok) return v.response;
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;
      const input = v.value;

      const {
        max_emails_per_user_per_day,
        max_emails_per_user_per_week,
        min_interval_between_emails_hours,
        send_window_start,
        send_window_end,
        send_window_days,
        send_window_timezone,
        tenant_timezone,
        batch_size_per_tick,
      } = input;

      if (send_window_start !== undefined && send_window_end !== undefined) {
        if (send_window_start >= send_window_end) {
          return c.json({ error: "send_window_end must be after send_window_start." }, 400);
        }
      }

      if (send_window_days !== undefined && send_window_days.length === 0) {
        return c.json({ error: "send_window_days must contain at least one day." }, 400);
      }

      if (send_window_timezone === "tenant_fixed" && (!tenant_timezone || tenant_timezone.trim().length === 0)) {
        return c.json({ error: "tenant_timezone is required when send_window_timezone is 'tenant_fixed'." }, 400);
      }

      const tenantRow = await storeFor(db).apiSettings.findTenantSettings(tenantId);

      if (!tenantRow) {
        return c.json({ error: "Tenant not found." }, 404);
      }

      const existing = (tenantRow.settings as Record<string, unknown> | null) ?? {};
      const existingThrottle = (existing.throttle as Record<string, unknown> | undefined) ?? {};

      const updates: Record<string, unknown> = {};
      if (max_emails_per_user_per_day !== undefined) updates.max_emails_per_user_per_day = max_emails_per_user_per_day;
      if (max_emails_per_user_per_week !== undefined) updates.max_emails_per_user_per_week = max_emails_per_user_per_week;
      if (min_interval_between_emails_hours !== undefined) updates.min_interval_between_emails_hours = min_interval_between_emails_hours;
      if (send_window_start !== undefined) updates.send_window_start = send_window_start;
      if (send_window_end !== undefined) updates.send_window_end = send_window_end;
      if (send_window_days !== undefined) updates.send_window_days = send_window_days;
      if (send_window_timezone !== undefined) updates.send_window_timezone = send_window_timezone;
      if (tenant_timezone !== undefined) updates.tenant_timezone = tenant_timezone;
      if (batch_size_per_tick !== undefined) updates.batch_size_per_tick = batch_size_per_tick;

      const mergedThrottle = { ...existingThrottle, ...updates };

      const updatedSettings = { ...existing, throttle: mergedThrottle };
      await storeFor(db).apiSettings.updateTenantSettings(tenantId, updatedSettings);

      const resolved = resolveThrottleConfig(mergedThrottle);
      return c.json({ throttle: resolved });
    },
  );

  /**
   * POST /v1/settings/test-email
   * Send a test email through the configured transport using the current
   * brand settings. The operator gets to see exactly what a real email
   * from this tenant looks like in their inbox.
   *
   * Body: { to: string } - recipient email address (typically the operator themselves)
   *
   * Prerequisites: transport must be configured, postal_address must be set.
   * If either is missing, returns 400 with an actionable message.
   */
  r.post(
    "/test-email",
    "owner",
    validatedBody(testEmailBodySchema),
    async (c) => {
      const v = validateBody(c, testEmailBodySchema);
      if (!v.ok) return v.response;
      const db: Db = c.var.db;
      const tenantId = c.var.tenant!.id;
      const { to } = v.value;

      if (!to.includes("@") || to.trim().length < 3) {
        return c.json({ error: "Invalid recipient email address." }, 400);
      }
      // The default transport (G26); see sendTestEmail in settings-transports.ts.
      const transport = (await loadTransportSetup(db, tenantId)).defaultTransport;
      const tenantRow = await storeFor(db).apiSettings.findTenantNameAndSettings(tenantId);
      if (!tenantRow) {
        return c.json({ error: "Tenant not found." }, 404);
      }
      const postalAddress = ((tenantRow.settings as Record<string, unknown> | null)?.postal_address) as string | undefined;
      if (!postalAddress || postalAddress.trim().length === 0) {
        return c.json({ error: "Postal address is not configured. Set it in Settings before sending a test email." }, 400);
      }
      if (!transport) {
        return c.json({ error: "Email transport is not configured. Set it up in Settings before sending a test email." }, 400);
      }
      const row = await storeFor(db).apiSettings.findActiveTransport({ tenantId, id: transport.id });
      if (!row) {
        return c.json({ error: "Email transport is not configured. Set it up in Settings before sending a test email." }, 400);
      }
      return sendTestEmail(c, db, tenantId, to, row);
    },
  );
  return r.app;
}

/** Simple HTML escape for test email content. */
function escapeHtmlSimple(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

