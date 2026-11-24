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
import type { FastifyPluginAsync } from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { encrypt, decrypt, parseEncryptionKey, resolveTransportAdapter, SmtpTransportAdapter } from "@claros/adapters";
import { transportConfigs, llmConfigs, tenants } from "@claros/db/schema";
import { wrapInShell, wrapInTextShell, buildShellComplianceHtml, buildShellComplianceText, resolveThrottleConfig, type BrandSettings } from "@claros/core";
import {
  KNOWN_LLM_PROVIDERS,
  isKnownLlmProvider,
  resolveLlmConfig,
  verifyLlmCredentials,
} from "../llm-providers.js";
import type { Db } from "../plugins/db.js";

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

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const settingsRoutes: FastifyPluginAsync = async (app) => {
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
  app.put<{
    Body: {
      provider: string;
      from_email: string;
      from_name?: string;
      // Resend fields
      api_key?: string;
      webhook_secret?: string;
      // SMTP fields
      host?: string;
      port?: number;
      secure?: boolean;
      username?: string;
      password?: string;
      reject_unauthorized?: boolean;
      // Shared
      daily_limit?: number;
    };
  }>(
    "/transport",
    {
      config: { minRole: "owner" as const },
      schema: {
        body: {
          type: "object",
          properties: {
            provider: { type: "string" },
            from_email: { type: "string", format: "email" },
            from_name: { type: "string" },
            api_key: { type: "string", minLength: 1 },
            webhook_secret: { type: "string" },
            host: { type: "string", minLength: 1 },
            port: { type: "integer", minimum: 1, maximum: 65535 },
            secure: { type: "boolean" },
            username: { type: "string" },
            password: { type: "string" },
            reject_unauthorized: { type: "boolean" },
            daily_limit: { type: "integer", minimum: 1 },
          },
          required: ["provider", "from_email"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const {
        provider, from_email, from_name, api_key, webhook_secret, daily_limit,
        host, port, secure, username, password, reject_unauthorized,
      } = request.body;

      // Validate provider
      if (!isKnownProvider(provider)) {
        reply.status(400);
        return {
          error: `Unknown provider: "${provider}". Valid values: ${KNOWN_PROVIDERS.join(", ")}.`,
        };
      }

      // Provider-specific field validation
      if (provider === "resend") {
        if (!api_key) {
          reply.status(400);
          return { error: "api_key is required for Resend." };
        }
      } else if (provider === "smtp") {
        if (!host || port === undefined) {
          reply.status(400);
          return { error: "host and port are required for SMTP." };
        }
      }

      // Require ENCRYPTION_KEY
      const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
      if (!encryptionKeyEnv) {
        reply.status(503);
        return {
          error:
            "ENCRYPTION_KEY is not configured. " +
            "Set ENCRYPTION_KEY before storing transport credentials.",
        };
      }

      let key: Buffer;
      try {
        key = parseEncryptionKey(encryptionKeyEnv);
      } catch (err) {
        reply.status(503);
        return {
          error: `ENCRYPTION_KEY is invalid: ${err instanceof Error ? err.message : String(err)}`,
        };
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
            reply.status(422);
            return {
              error: `SMTP verification failed: ${verification.error}. Nothing was stored.`,
            };
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
      await db
        .update(transportConfigs)
        .set({ isActive: false })
        .where(
          and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)),
        );

      const [inserted] = await db
        .insert(transportConfigs)
        .values({
          tenantId,
          provider,
          config: sql`${encryptedConfig}::jsonb`,
          isActive: true,
          fromEmail: from_email,
          fromName: from_name ?? null,
          dailyLimit: daily_limit ?? null,
        })
        .returning({
          id: transportConfigs.id,
          provider: transportConfigs.provider,
          fromEmail: transportConfigs.fromEmail,
          fromName: transportConfigs.fromName,
          dailyLimit: transportConfigs.dailyLimit,
          dkimVerified: transportConfigs.dkimVerified,
          isActive: transportConfigs.isActive,
          createdAt: transportConfigs.createdAt,
        });

      reply.status(200);
      return {
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
      };
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
  app.get("/transport", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rows = await db
      .select({
        id: transportConfigs.id,
        provider: transportConfigs.provider,
        fromEmail: transportConfigs.fromEmail,
        fromName: transportConfigs.fromName,
        dailyLimit: transportConfigs.dailyLimit,
        dkimVerified: transportConfigs.dkimVerified,
        isActive: transportConfigs.isActive,
        createdAt: transportConfigs.createdAt,
      })
      .from(transportConfigs)
      .where(
        and(eq(transportConfigs.tenantId, tenantId), eq(transportConfigs.isActive, true)),
      )
      .limit(1);

    if (rows.length === 0) {
      return { transport: null };
    }

    const row = rows[0]!;
    return {
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
    };
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
  app.put<{
    Body: {
      provider: string;
      api_key?: string;
      base_url?: string;
      model?: string;
      embedding_model?: string;
    };
  }>(
    "/llm",
    {
      config: { minRole: "owner" as const },
      schema: {
        body: {
          type: "object",
          properties: {
            provider: { type: "string" },
            api_key: { type: "string" },
            base_url: { type: "string", minLength: 1 },
            model: { type: "string", minLength: 1 },
            embedding_model: { type: "string" },
          },
          required: ["provider"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const { provider, api_key, base_url, model, embedding_model } = request.body;

      // Validate provider
      if (!isKnownLlmProvider(provider)) {
        reply.status(400);
        return {
          error: `Unknown provider: "${provider}". Valid values: ${KNOWN_LLM_PROVIDERS.join(", ")}.`,
        };
      }

      // Apply per-provider defaults; overrides win when present.
      const resolved = resolveLlmConfig(provider, {
        apiKey: api_key,
        baseUrl: base_url,
        model,
        embeddingModel: embedding_model,
      });
      if (!resolved.ok) {
        reply.status(400);
        return { error: resolved.error };
      }
      const effective = resolved.config;

      // Require ENCRYPTION_KEY
      const encryptionKeyEnv = process.env.ENCRYPTION_KEY;
      if (!encryptionKeyEnv) {
        reply.status(503);
        return {
          error:
            "ENCRYPTION_KEY is not configured. " +
            "Set ENCRYPTION_KEY before storing LLM credentials.",
        };
      }

      let key: Buffer;
      try {
        key = parseEncryptionKey(encryptionKeyEnv);
      } catch (err) {
        reply.status(503);
        return {
          error: `ENCRYPTION_KEY is invalid: ${err instanceof Error ? err.message : String(err)}`,
        };
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
        reply.status(422);
        const prefix =
          verification.kind === "http"
            ? `${effective.baseUrl} rejected the credentials (HTTP ${verification.status})`
            : verification.kind === "timeout"
              ? `${effective.baseUrl} did not answer within 10 seconds`
              : `${effective.baseUrl} could not be reached`;
        const said = verification.detail !== "" ? `: ${verification.detail}` : "";
        return {
          error: `${prefix}${said}. Nothing was stored.`,
          verification: {
            ok: false,
            kind: verification.kind,
            status: verification.status,
            detail: verification.detail,
          },
        };
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
      await db
        .update(llmConfigs)
        .set({ isActive: false })
        .where(
          and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)),
        );

      const [inserted] = await db
        .insert(llmConfigs)
        .values({
          tenantId,
          provider,
          config: encryptedConfig,
          isActive: true,
        })
        .returning({
          id: llmConfigs.id,
          provider: llmConfigs.provider,
          isActive: llmConfigs.isActive,
          createdAt: llmConfigs.createdAt,
        });

      reply.status(200);
      return {
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
      };
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
  app.get("/llm", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rows = await db
      .select({
        id: llmConfigs.id,
        provider: llmConfigs.provider,
        config: llmConfigs.config,
        isActive: llmConfigs.isActive,
        createdAt: llmConfigs.createdAt,
      })
      .from(llmConfigs)
      .where(
        and(eq(llmConfigs.tenantId, tenantId), eq(llmConfigs.isActive, true)),
      )
      .limit(1);

    if (rows.length === 0) {
      return { llm: null };
    }

    const row = rows[0]!;

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

    return {
      llm: {
        id: row.id,
        provider: row.provider,
        model,
        base_url: baseUrl,
        embedding_model: embeddingModel,
        is_active: row.isActive,
        created_at: row.createdAt,
      },
    };
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
  app.get("/tenant", { config: { minRole: "member" } }, async (request, reply) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const rows = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        plan: tenants.plan,
        settings: tenants.settings,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (rows.length === 0) {
      reply.status(404);
      return { error: "Tenant not found." };
    }

    const row = rows[0]!;
    const settings = (row.settings as Record<string, unknown> | null) ?? {};
    const brand = (settings.brand as Record<string, unknown> | undefined) ?? {};

    return {
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
          logo_height: (brand.logo_height as number | undefined) ?? null,
          accent_color: (brand.accent_color as string | undefined) ?? null,
          footer_text: (brand.footer_text as string | undefined) ?? null,
          reply_to: (brand.reply_to as string | undefined) ?? null,
        },
        created_at: row.createdAt,
      },
    };
  });

  // -------------------------------------------------------------------------
  // PATCH /v1/settings/tenant
  // -------------------------------------------------------------------------

  /**
   * PATCH /v1/settings/tenant
   * Update operator-managed tenant settings.
   *
   * Supports: postal_address, brain_context, brand (object with brand_name,
   * logo_url, logo_height, accent_color, footer_text, reply_to).
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
  app.patch<{
    Body: {
      postal_address?: string;
      brain_context?: string | null;
      brand?: {
        brand_name?: string | null;
        logo_url?: string | null;
        logo_height?: number | null;
        accent_color?: string | null;
        footer_text?: string | null;
        reply_to?: string | null;
      };
    };
  }>(
    "/tenant",
    {
      config: { minRole: "owner" as const },
      schema: {
        body: {
          type: "object",
          properties: {
            postal_address: { type: "string" },
            brain_context: { type: ["string", "null"] },
            brand: {
              type: "object",
              properties: {
                brand_name: { type: ["string", "null"] },
                logo_url: { type: ["string", "null"] },
                logo_height: { type: ["number", "null"] },
                accent_color: { type: ["string", "null"] },
                footer_text: { type: ["string", "null"] },
                reply_to: { type: ["string", "null"] },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const { postal_address, brain_context, brand } = request.body;

      // Nothing to update
      if (postal_address === undefined && brain_context === undefined && brand === undefined) {
        reply.status(400);
        return {
          error: "No updatable fields provided. Supported: postal_address, brain_context, brand.",
        };
      }

      // Validate postal_address if provided
      if (postal_address !== undefined && postal_address.trim().length === 0) {
        reply.status(400);
        return {
          error:
            "postal_address must be a non-empty string. " +
            "An empty postal address would block outgoing mail (CAN-SPAM compliance).",
        };
      }

      // Validate brain_context if provided
      if (
        brain_context !== undefined &&
        brain_context !== null &&
        brain_context.length > BRAIN_CONTEXT_MAX_CHARS
      ) {
        reply.status(400);
        return {
          error:
            `brain_context must be at most ${BRAIN_CONTEXT_MAX_CHARS} characters. ` +
            "It is injected into every LLM prompt; longer texts blow the context budget.",
        };
      }

      // Validate brand fields if provided
      if (brand) {
        if (brand.logo_url !== undefined && brand.logo_url !== null) {
          // Must be a valid absolute URL (http or https)
          try {
            const url = new URL(brand.logo_url);
            if (!["http:", "https:"].includes(url.protocol)) {
              reply.status(400);
              return { error: "brand.logo_url must be an http or https URL." };
            }
          } catch {
            reply.status(400);
            return { error: "brand.logo_url must be a valid URL." };
          }
        }
        if (brand.accent_color !== undefined && brand.accent_color !== null) {
          if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(brand.accent_color)) {
            reply.status(400);
            return { error: "brand.accent_color must be a valid hex color (e.g. #2563eb)." };
          }
        }
        if (brand.reply_to !== undefined && brand.reply_to !== null) {
          // Basic email format check
          if (!brand.reply_to.includes("@") || brand.reply_to.trim().length < 3) {
            reply.status(400);
            return { error: "brand.reply_to must be a valid email address." };
          }
        }
        if (brand.logo_height !== undefined && brand.logo_height !== null) {
          if (brand.logo_height < 16 || brand.logo_height > 64) {
            reply.status(400);
            return { error: "brand.logo_height must be between 16 and 64." };
          }
        }
      }

      // Read current settings, merge, write back
      const tenantRows = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (tenantRows.length === 0) {
        reply.status(404);
        return { error: "Tenant not found." };
      }

      const existing = (tenantRows[0]!.settings as Record<string, unknown> | null) ?? {};
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

      await db.update(tenants).set({ settings: updated }).where(eq(tenants.id, tenantId));

      const finalBrand = (updated.brand as Record<string, unknown> | undefined) ?? {};

      reply.status(200);
      return {
        tenant: {
          postal_address: (updated.postal_address as string | undefined) ?? null,
          brain_context: (updated.brain_context as string | undefined) ?? null,
          brand: {
            brand_name: (finalBrand.brand_name as string | undefined) ?? null,
            logo_url: (finalBrand.logo_url as string | undefined) ?? null,
            logo_height: (finalBrand.logo_height as number | undefined) ?? null,
            accent_color: (finalBrand.accent_color as string | undefined) ?? null,
            footer_text: (finalBrand.footer_text as string | undefined) ?? null,
            reply_to: (finalBrand.reply_to as string | undefined) ?? null,
          },
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/settings/test-email
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Throttle settings
  // -------------------------------------------------------------------------

  const DAYS_OF_WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

  /**
   * GET /v1/settings/throttle
   * Read the current throttle configuration.
   * Returns the resolved config (defaults filled in for missing fields).
   */
  app.get("/throttle", { config: { minRole: "member" } }, async (request) => {
    const db: Db = request.server.db;
    const tenantId = request.tenant!.id;

    const tenantRows = await db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (tenantRows.length === 0) {
      return { error: "Tenant not found." };
    }

    const settings = (tenantRows[0]!.settings as Record<string, unknown> | null) ?? {};
    const config = resolveThrottleConfig(settings.throttle ?? null);

    return { throttle: config };
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
  app.put<{
    Body: {
      max_emails_per_user_per_day?: number;
      max_emails_per_user_per_week?: number;
      min_interval_between_emails_hours?: number;
      send_window_start?: string;
      send_window_end?: string;
      send_window_days?: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
      send_window_timezone?: "contact_local" | "tenant_fixed";
      tenant_timezone?: string;
      batch_size_per_tick?: number;
    };
  }>(
    "/throttle",
    {
      config: { minRole: "owner" as const },
      schema: {
        body: {
          type: "object",
          properties: {
            max_emails_per_user_per_day: { type: "integer", minimum: 0, maximum: 100 },
            max_emails_per_user_per_week: { type: "integer", minimum: 0, maximum: 500 },
            min_interval_between_emails_hours: { type: "number", minimum: 0, maximum: 168 },
            send_window_start: { type: "string", pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" },
            send_window_end: { type: "string", pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$" },
            send_window_days: { type: "array", items: { type: "string", enum: DAYS_OF_WEEK } },
            send_window_timezone: { type: "string", enum: ["contact_local", "tenant_fixed"] },
            tenant_timezone: { type: "string" },
            batch_size_per_tick: { type: "integer", minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const input = request.body;

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
          reply.status(400);
          return { error: "send_window_end must be after send_window_start." };
        }
      }

      if (send_window_days !== undefined && send_window_days.length === 0) {
        reply.status(400);
        return { error: "send_window_days must contain at least one day." };
      }

      if (send_window_timezone === "tenant_fixed" && (!tenant_timezone || tenant_timezone.trim().length === 0)) {
        reply.status(400);
        return { error: "tenant_timezone is required when send_window_timezone is 'tenant_fixed'." };
      }

      const tenantRows = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (tenantRows.length === 0) {
        reply.status(404);
        return { error: "Tenant not found." };
      }

      const existing = (tenantRows[0]!.settings as Record<string, unknown> | null) ?? {};
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
      await db.update(tenants).set({ settings: updatedSettings }).where(eq(tenants.id, tenantId));

      const resolved = resolveThrottleConfig(mergedThrottle);
      return { throttle: resolved };
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
  app.post<{
    Body: {
      to: string;
    };
  }>(
    "/test-email",
    {
      config: { minRole: "owner" as const },
      schema: {
        body: {
          type: "object",
          required: ["to"],
          properties: {
            to: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const db: Db = request.server.db;
      const tenantId = request.tenant!.id;
      const { to } = request.body;

      // Validate recipient
      if (!to.includes("@") || to.trim().length < 3) {
        reply.status(400);
        return { error: "Invalid recipient email address." };
      }

      // Resolve tenant settings (name, postal_address, brand)
      const tenantRows = await db
        .select({ name: tenants.name, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (tenantRows.length === 0) {
        reply.status(404);
        return { error: "Tenant not found." };
      }

      const tenantName = tenantRows[0]!.name;
      const settings = (tenantRows[0]!.settings as Record<string, unknown> | null) ?? {};
      const postalAddress = settings.postal_address as string | undefined;
      const brand = (settings.brand as BrandSettings | undefined) ?? {};

      if (!postalAddress || postalAddress.trim().length === 0) {
        reply.status(400);
        return { error: "Postal address is not configured. Set it in Settings before sending a test email." };
      }

      // Resolve transport
      const configRows = await db.execute<{
        provider: string;
        config: string;
        from_email: string;
        from_name: string | null;
      }>(sql`
        SELECT provider, config::text AS config, from_email, from_name
        FROM transport_configs
        WHERE tenant_id = ${tenantId}::uuid
          AND is_active = true
        LIMIT 1
      `);

      if (configRows.rows.length === 0) {
        reply.status(400);
        return { error: "Email transport is not configured. Set it up in Settings before sending a test email." };
      }

      const configRow = configRows.rows[0]!;
      const resolveResult = resolveTransportAdapter(configRow.provider, configRow.config);

      if (!resolveResult.ok) {
        reply.status(500);
        return { error: "Failed to initialize email transport. Check your transport configuration." };
      }

      const adapter = resolveResult.transport.adapter;
      const fromEmail = configRow.from_email;
      const fromName = configRow.from_name ?? undefined;

      // Build test email content
      const subject = `Test email from ${tenantName}`;
      const bodyHtml = [
        `<p>This is a test email from <strong>${escapeHtmlSimple(tenantName)}</strong>.</p>`,
        `<p>If you can read this, your email branding and transport are working correctly.</p>`,
        `<p>This message was sent using your current brand settings. Check that:</p>`,
        `<ul>`,
        `<li>The logo or brand name appears in the header</li>`,
        `<li>The accent color bar is visible at the top</li>`,
        `<li>The footer contains your postal address and unsubscribe link</li>`,
        `<li>The overall layout looks professional in your email client</li>`,
        `</ul>`,
        `<p style="color:#6b7280;font-size:13px;">Sent at ${new Date().toISOString()}</p>`,
      ].join("\n");

      const bodyText = [
        `This is a test email from ${tenantName}.`,
        ``,
        `If you can read this, your email branding and transport are working correctly.`,
        ``,
        `This message was sent using your current brand settings. Check that:`,
        `- The overall layout looks professional in your email client`,
        `- The footer contains your postal address and unsubscribe link`,
        ``,
        `Sent at ${new Date().toISOString()}`,
      ].join("\n");

      // Build compliance fragments with real unsubscribe token and headers.
      // The test-email must carry List-Unsubscribe headers like every real send.
      const signingKey = process.env.UNSUBSCRIBE_SIGNING_KEY;
      if (!signingKey) {
        reply.status(400);
        return { error: "UNSUBSCRIBE_SIGNING_KEY is not set. Set it before sending any email (including test emails)." };
      }

      const testMessageId = `test-${Date.now()}`;
      const { generateUnsubscribeToken } = await import("@claros/adapters");
      const token = generateUnsubscribeToken(tenantId, testMessageId, signingKey);
      const baseUrlForLinks = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
      const oneClickUrl = `${baseUrlForLinks}/unsubscribe/one-click?token=${token}`;
      const browserUrl = `${baseUrlForLinks}/unsubscribe?token=${token}`;

      const complianceHtml = buildShellComplianceHtml(browserUrl, postalAddress);
      const complianceText = buildShellComplianceText(browserUrl, postalAddress);

      // Wrap in shell
      const deliveredHtml = wrapInShell({
        bodyHtml,
        brand,
        tenantName,
        complianceFooterHtml: complianceHtml,
      });
      const deliveredText = wrapInTextShell({
        bodyText,
        brand,
        tenantName,
        complianceFooterText: complianceText,
      });

      // Send
      try {
        const result = await adapter.send({
          to: to.trim(),
          from: fromEmail,
          fromName,
          subject,
          bodyHtml: deliveredHtml,
          bodyText: deliveredText,
          messageId: testMessageId,
          headers: {
            "List-Unsubscribe": `<${oneClickUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });

        if (result.success) {
          return { sent: true, to: to.trim() };
        }

        reply.status(502);
        return { error: "Transport rejected the message. Check your transport configuration." };
      } catch (err) {
        reply.status(502);
        return { error: "Failed to send test email. Check your transport configuration and credentials." };
      }
    },
  );
};

/** Simple HTML escape for test email content. */
function escapeHtmlSimple(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default settingsRoutes;
