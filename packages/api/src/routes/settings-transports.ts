/**
 * Transports (G26, D16): several transports per product with routing.
 * Registered on the settings router (/v1/settings).
 *
 *   GET    /v1/settings/transports            list active transports + routing (member)
 *   POST   /v1/settings/transports            add a transport (owner)
 *   PATCH  /v1/settings/transports/:id        update a transport (owner)
 *   DELETE /v1/settings/transports/:id        deactivate a transport (owner; kept for history)
 *   POST   /v1/settings/transports/:id/test   send a test email through it (owner)
 *   PUT    /v1/settings/transport-routing     { transactional?, default? } (owner)
 *
 * Kinds and credentials (encrypted at rest with ENCRYPTION_KEY):
 *   resend      { api_key, webhook_secret? }
 *   smtp        { host, port, secure?, username?, password?, reject_unauthorized? }
 *   cloudflare  { account_id, api_token } for the REST API; on Workers with the
 *               send_email binding (EMAIL) both may be omitted.
 *
 * Routing: transactional-kind messages use routing.transactional, else the
 * default; everything else uses routing.default; without routing the
 * default is the oldest active transport (the single transport of a product
 * that never added a second one). Cloudflare Email Service is for
 * transactional mail only: routing.default may not name a cloudflare
 * transport (400), and the drain fails any non-transactional message routed
 * to one (transport_policy).
 *
 * The v0.6 endpoints PUT/GET /v1/settings/transport keep working on the
 * default transport.
 *
 * Every route here also accepts an instance key with the transports:write
 * scope, acting on the product named by X-Claros-Product or ?product=.
 */
import { z } from "zod";
import { storeFor, type SettingsTransportDetailRow } from "@claros/store";
import {
  encrypt,
  parseEncryptionKey,
  resolveTransportAdapter,
  SmtpTransportAdapter,
  transportRuntime,
  generateUnsubscribeToken,
} from "@claros/adapters";
import {
  TRANSPORT_KINDS,
  selectTransport,
  wrapInShell,
  wrapInTextShell,
  buildShellComplianceHtml,
  buildShellComplianceText,
  type BrandSettings,
  type TransportRouting,
} from "@claros/core";
import type { Db } from "../plugins/db.js";
import type { AppContext } from "../http/env.js";
import { allowInstanceKey, type RoleRouter } from "../http/router.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The "email" format v0.6 applied (ajv-formats, full mode). */
const EMAIL_FORMAT =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

const email = () => z.string().trim().regex(EMAIL_FORMAT, 'must match format "email"');

const credentialFields = {
  api_key: z.string().min(1).optional(),
  webhook_secret: z.string().optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  reject_unauthorized: z.boolean().optional(),
  account_id: z.string().min(1).optional(),
  api_token: z.string().min(1).optional(),
};

const createSchema = z.object({
  kind: z.enum(TRANSPORT_KINDS as unknown as [string, ...string[]], {
    errorMap: () => ({ message: `kind must be one of: ${TRANSPORT_KINDS.join(", ")}` }),
  }),
  name: z.string().trim().max(200).nullable().optional(),
  from_email: email(),
  from_name: z.string().max(200).nullable().optional(),
  reply_to: email().nullable().optional(),
  daily_limit: z.number().int().min(1).nullable().optional(),
  ...credentialFields,
});

const patchSchema = z
  .object({
    name: z.string().trim().max(200).nullable().optional(),
    from_email: email().optional(),
    from_name: z.string().max(200).nullable().optional(),
    reply_to: email().nullable().optional(),
    daily_limit: z.number().int().min(1).nullable().optional(),
    ...credentialFields,
  })
  .strict();

const routingSchema = z
  .object({
    transactional: z.string().regex(UUID_RE, "must be a transport id").nullable().optional(),
    default: z.string().regex(UUID_RE, "must be a transport id").nullable().optional(),
  })
  .strict();

const testSchema = z.object({ to: z.string().trim().min(3) });

type CredentialInput = { [K in keyof typeof credentialFields]?: z.infer<(typeof credentialFields)[K]> };

function validationError(c: AppContext, issues: z.ZodIssue[]): Response {
  return c.json(
    { error: "Validation failed", issues: issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    400,
  );
}

/** Transport as the API shows it: never any credential. */
export function serializeTransport(row: SettingsTransportDetailRow) {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    name: row.name,
    from_email: row.fromEmail,
    from_name: row.fromName,
    reply_to: row.replyTo,
    daily_limit: row.dailyLimit,
    dkim_verified: row.dkimVerified,
    is_active: row.isActive,
    created_at: row.createdAt,
  };
}

/** tenants.settings.transport_routing as transport ids. */
export function routingOf(settings: unknown): TransportRouting {
  const r = (settings as Record<string, unknown> | null)?.transport_routing as Record<string, unknown> | undefined;
  const out: TransportRouting = {};
  if (typeof r?.transactional === "string") out.transactional = r.transactional;
  if (typeof r?.default === "string") out.default = r.default;
  return out;
}

/** The product's active transports, routing and the default transport. */
export async function loadTransportSetup(db: Db, tenantId: string) {
  const store = storeFor(db).apiSettings;
  const [active, tenantSettings] = await Promise.all([
    store.listActiveTransports(tenantId),
    store.findTenantSettings(tenantId),
  ]);
  const routing = routingOf(tenantSettings?.settings ?? null);
  return {
    active,
    routing,
    settings: (tenantSettings?.settings as Record<string, unknown> | null) ?? {},
    defaultTransport: selectTransport(active, routing, "default"),
    transactionalTransport: selectTransport(active, routing, "transactional"),
  };
}

/** Write transport_routing into tenants.settings (other keys untouched). */
export async function saveRouting(
  db: Db,
  tenantId: string,
  settings: Record<string, unknown>,
  routing: TransportRouting,
): Promise<void> {
  const next: Record<string, unknown> = { ...settings };
  const clean: Record<string, string> = {};
  if (routing.transactional) clean.transactional = routing.transactional;
  if (routing.default) clean.default = routing.default;
  if (Object.keys(clean).length > 0) next.transport_routing = clean;
  else delete next.transport_routing;
  await storeFor(db).apiSettings.updateTenantSettings(tenantId, next);
}

/** The encryption key, or a 503 response. */
function encryptionKey(c: AppContext): { ok: true; key: Buffer } | { ok: false; response: Response } {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    return {
      ok: false,
      response: c.json(
        { error: "ENCRYPTION_KEY is not configured. Set ENCRYPTION_KEY before storing transport credentials." },
        503,
      ),
    };
  }
  try {
    return { ok: true, key: parseEncryptionKey(raw) };
  } catch (err) {
    return {
      ok: false,
      response: c.json({ error: `ENCRYPTION_KEY is invalid: ${err instanceof Error ? err.message : String(err)}` }, 503),
    };
  }
}

/**
 * Build and check the credentials of a kind. Returns the credential object to
 * encrypt, or an error message (400).
 */
async function buildCredentials(
  kind: string,
  input: CredentialInput,
): Promise<{ ok: true; credentials: Record<string, unknown> } | { ok: false; status: 400 | 422; error: string }> {
  if (kind === "resend") {
    if (!input.api_key) return { ok: false, status: 400, error: "api_key is required for Resend." };
    const credentials: Record<string, unknown> = { apiKey: input.api_key };
    if (input.webhook_secret) credentials.webhookSecret = input.webhook_secret;
    return { ok: true, credentials };
  }
  if (kind === "smtp") {
    if (!input.host || input.port === undefined) {
      return { ok: false, status: 400, error: "host and port are required for SMTP." };
    }
    const config = {
      host: input.host,
      port: input.port,
      secure: input.secure ?? input.port === 465,
      username: input.username || undefined,
      password: input.password || undefined,
      rejectUnauthorized: input.reject_unauthorized ?? true,
    };
    // Verify on Node (EHLO + AUTH). On Workers (an SMTP factory is
    // registered) there is no verify without sending; the test send covers it.
    if (!transportRuntime().smtp) {
      const probe = new SmtpTransportAdapter(config);
      try {
        const verification = await probe.verify();
        if (!verification.ok) {
          return { ok: false, status: 422, error: `SMTP verification failed: ${verification.error}. Nothing was stored.` };
        }
      } finally {
        probe.close();
      }
    }
    return { ok: true, credentials: config };
  }
  // cloudflare
  const hasRest = Boolean(input.account_id && input.api_token);
  if ((input.account_id && !input.api_token) || (!input.account_id && input.api_token)) {
    return { ok: false, status: 400, error: "account_id and api_token go together for Cloudflare Email Service." };
  }
  if (!hasRest && !transportRuntime().cloudflareBinding) {
    return {
      ok: false,
      status: 400,
      error:
        "account_id and api_token are required for Cloudflare Email Service " +
        "(on Workers they may be omitted when the send_email binding EMAIL is configured).",
    };
  }
  return { ok: true, credentials: hasRest ? { accountId: input.account_id, apiToken: input.api_token } : {} };
}

/** True when any credential field is present in the input. */
function hasCredentialInput(input: CredentialInput): boolean {
  return (Object.keys(credentialFields) as Array<keyof CredentialInput>).some((k) => input[k] !== undefined);
}

/**
 * Send a branded test email through one transport, with the compliance footer
 * and List-Unsubscribe headers like every real send.
 */
export async function sendTestEmail(
  c: AppContext,
  db: Db,
  tenantId: string,
  to: string,
  transport: { kind: string; config: string; fromEmail: string; fromName: string | null; replyTo: string | null },
): Promise<Response> {
  if (!to.includes("@") || to.trim().length < 3) {
    return c.json({ error: "Invalid recipient email address." }, 400);
  }
  const tenantRow = await storeFor(db).apiSettings.findTenantNameAndSettings(tenantId);
  if (!tenantRow) return c.json({ error: "Tenant not found." }, 404);

  const tenantName = tenantRow.name;
  const settings = (tenantRow.settings as Record<string, unknown> | null) ?? {};
  const postalAddress = settings.postal_address as string | undefined;
  const brand = (settings.brand as BrandSettings | undefined) ?? {};
  if (!postalAddress || postalAddress.trim().length === 0) {
    return c.json({ error: "Postal address is not configured. Set it in Settings before sending a test email." }, 400);
  }

  const resolved = resolveTransportAdapter(transport.kind, transport.config);
  if (!resolved.ok) {
    return c.json({ error: "Failed to initialize email transport. Check your transport configuration." }, 500);
  }
  const adapter = resolved.transport.adapter;

  const subject = `Test email from ${tenantName}`;
  const bodyHtml = [
    `<p>This is a test email from <strong>${escapeHtml(tenantName)}</strong>.</p>`,
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

  const signingKey = process.env.UNSUBSCRIBE_SIGNING_KEY;
  if (!signingKey) {
    return c.json({ error: "UNSUBSCRIBE_SIGNING_KEY is not set. Set it before sending any email (including test emails)." }, 400);
  }
  const testMessageId = `test-${Date.now()}`;
  const token = generateUnsubscribeToken(tenantId, testMessageId, signingKey);
  const baseUrlForLinks = tenantRow.publicHost
    ? `https://${tenantRow.publicHost}`
    : process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const oneClickUrl = `${baseUrlForLinks}/unsubscribe/one-click?token=${token}`;
  const browserUrl = `${baseUrlForLinks}/unsubscribe?token=${token}`;

  const deliveredHtml = wrapInShell({
    bodyHtml,
    brand,
    tenantName,
    complianceFooterHtml: buildShellComplianceHtml(browserUrl, postalAddress),
  });
  const deliveredText = wrapInTextShell({
    bodyText,
    brand,
    tenantName,
    complianceFooterText: buildShellComplianceText(browserUrl, postalAddress),
  });
  const replyTo = transport.replyTo ?? (typeof brand.reply_to === "string" && brand.reply_to ? brand.reply_to : undefined);

  try {
    const result = await adapter.send({
      to: to.trim(),
      from: transport.fromEmail,
      fromName: transport.fromName ?? undefined,
      ...(replyTo ? { replyTo } : {}),
      subject,
      bodyHtml: deliveredHtml,
      bodyText: deliveredText,
      messageId: testMessageId,
      headers: {
        "List-Unsubscribe": `<${oneClickUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (result.success) return c.json({ sent: true, to: to.trim() });
    return c.json({ error: "Transport rejected the message. Check your transport configuration." }, 502);
  } catch {
    return c.json({ error: "Failed to send test email. Check your transport configuration and credentials." }, 502);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Register the multi-transport routes on the settings router. */
export function registerTransportRoutes(r: RoleRouter): void {
  r.get("/transports", "member", allowInstanceKey("transports:write"), async (c) => {
    const db: Db = c.var.db;
    const setup = await loadTransportSetup(db, c.var.tenant!.id);
    return c.json({
      transports: setup.active.map(serializeTransport),
      routing: { transactional: setup.routing.transactional ?? null, default: setup.routing.default ?? null },
      effective: {
        default: setup.defaultTransport?.id ?? null,
        transactional: setup.transactionalTransport?.id ?? null,
      },
    });
  });

  r.post("/transports", "owner", allowInstanceKey("transports:write"), async (c) => {
    const parsed = createSchema.safeParse(c.var.body);
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const body = parsed.data;
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const key = encryptionKey(c);
    if (!key.ok) return key.response;
    const creds = await buildCredentials(body.kind, body);
    if (!creds.ok) return c.json({ error: creds.error }, creds.status);

    const inserted = await storeFor(db).apiSettings.insertTransport({
      tenantId,
      kind: body.kind,
      name: body.name ?? null,
      encryptedConfig: encrypt(JSON.stringify(creds.credentials), key.key),
      fromEmail: body.from_email,
      fromName: body.from_name ?? null,
      replyTo: body.reply_to ?? null,
      dailyLimit: body.daily_limit ?? null,
    });
    return c.json({ transport: serializeTransport(inserted!) }, 201);
  });

  r.patch("/transports/:id", "owner", allowInstanceKey("transports:write"), async (c) => {
    const id = c.req.param("id") ?? "";
    if (!UUID_RE.test(id)) return c.json({ error: "Transport not found." }, 404);
    const parsed = patchSchema.safeParse(c.var.body ?? {});
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const body = parsed.data;
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;

    const current = await storeFor(db).apiSettings.findActiveTransport({ tenantId, id: id.toLowerCase() });
    if (!current) return c.json({ error: "Transport not found." }, 404);

    let encryptedConfig: string | undefined;
    if (hasCredentialInput(body)) {
      const key = encryptionKey(c);
      if (!key.ok) return key.response;
      const creds = await buildCredentials(current.kind, body);
      if (!creds.ok) return c.json({ error: creds.error }, creds.status);
      encryptedConfig = encrypt(JSON.stringify(creds.credentials), key.key);
    }

    const updated = await storeFor(db).apiSettings.updateTransport({
      tenantId,
      id: current.id,
      patch: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.from_email !== undefined ? { fromEmail: body.from_email } : {}),
        ...(body.from_name !== undefined ? { fromName: body.from_name } : {}),
        ...(body.reply_to !== undefined ? { replyTo: body.reply_to } : {}),
        ...(body.daily_limit !== undefined ? { dailyLimit: body.daily_limit } : {}),
        ...(encryptedConfig !== undefined ? { encryptedConfig } : {}),
      },
    });
    if (!updated) return c.json({ error: "Transport not found." }, 404);
    return c.json({ transport: serializeTransport(updated) });
  });

  r.delete("/transports/:id", "owner", allowInstanceKey("transports:write"), async (c) => {
    const id = c.req.param("id") ?? "";
    if (!UUID_RE.test(id)) return c.json({ error: "Transport not found." }, 404);
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const setup = await loadTransportSetup(db, tenantId);
    const target = setup.active.find((t) => t.id === id.toLowerCase());
    if (!target) return c.json({ error: "Transport not found." }, 404);

    await storeFor(db).apiSettings.deactivateTransport({ tenantId, id: target.id });

    // Routing that named it falls back to the default rules.
    const routing = { ...setup.routing };
    let changed = false;
    if (routing.default === target.id) {
      delete routing.default;
      changed = true;
    }
    if (routing.transactional === target.id) {
      delete routing.transactional;
      changed = true;
    }
    if (changed) await saveRouting(db, tenantId, setup.settings, routing);
    return c.json({ deleted: true, id: target.id });
  });

  r.post("/transports/:id/test", "owner", allowInstanceKey("transports:write"), async (c) => {
    const id = c.req.param("id") ?? "";
    if (!UUID_RE.test(id)) return c.json({ error: "Transport not found." }, 404);
    const parsed = testSchema.safeParse(c.var.body);
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const row = await storeFor(db).apiSettings.findActiveTransport({ tenantId, id: id.toLowerCase() });
    if (!row) return c.json({ error: "Transport not found." }, 404);
    return sendTestEmail(c, db, tenantId, parsed.data.to, row);
  });

  r.put("/transport-routing", "owner", allowInstanceKey("transports:write"), async (c) => {
    const parsed = routingSchema.safeParse(c.var.body ?? {});
    if (!parsed.success) return validationError(c, parsed.error.issues);
    const body = parsed.data;
    const db: Db = c.var.db;
    const tenantId = c.var.tenant!.id;
    const setup = await loadTransportSetup(db, tenantId);

    const next: TransportRouting = { ...setup.routing };
    for (const route of ["transactional", "default"] as const) {
      const value = body[route];
      if (value === undefined) continue;
      if (value === null) {
        delete next[route];
        continue;
      }
      const transport = setup.active.find((t) => t.id === value.toLowerCase());
      if (!transport) {
        return c.json({ error: `routing.${route} does not name an active transport of this product.` }, 400);
      }
      // Hard guard (D16): the default route carries marketing and lifecycle
      // mail, which Cloudflare Email Service does not allow.
      if (route === "default" && transport.kind === "cloudflare") {
        return c.json(
          {
            error:
              "Cloudflare Email Service is for transactional mail only and cannot be the default transport. " +
              "Use it for the transactional route.",
          },
          400,
        );
      }
      next[route] = transport.id;
    }

    await saveRouting(db, tenantId, setup.settings, next);
    const effectiveDefault = selectTransport(setup.active, next, "default");
    const warnings: string[] = [];
    if (effectiveDefault?.kind === "cloudflare") {
      warnings.push(
        "The default route falls back to a Cloudflare transport: non-transactional mail will fail with transport_policy " +
          "until another transport is the default.",
      );
    }
    return c.json({
      routing: { transactional: next.transactional ?? null, default: next.default ?? null },
      effective: {
        default: effectiveDefault?.id ?? null,
        transactional: selectTransport(setup.active, next, "transactional")?.id ?? null,
      },
      warnings,
    });
  });
}
