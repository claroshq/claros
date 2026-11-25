/**
 * Fixtures for the Postgres HTTP tests of the management API: a product
 * with an owner and a member session, ingestion and admin keys, and a
 * cleanup that removes every row of the product.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { buildApp, hashApiKey } from "../../src/index.js";
import { tenants, users, sessions, apiKeys, contacts, flows, flowMemberships, lifecycleMessages } from "@claros/db/schema";

export type TestDb = ReturnType<typeof drizzle>;

export function openDb(): { pool: pg.Pool; db: TestDb } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return { pool, db: drizzle(pool) };
}

export interface TestProduct {
  tenantId: string;
  slug: string;
  ownerId: string;
  ownerCookie: string;
  memberCookie: string;
}

export async function newProduct(db: TestDb, label = "integ"): Promise<TestProduct> {
  const slug = `test-${label}-${randomUUID().slice(0, 8)}`;
  const [t] = await db.insert(tenants).values({ name: `Test ${label}`, slug }).returning({ id: tenants.id });
  const tenantId = t!.id;
  const [owner] = await db.insert(users).values({ tenantId, email: `owner-${slug}@example.com`, role: "owner" }).returning({ id: users.id });
  const [member] = await db.insert(users).values({ tenantId, email: `member-${slug}@example.com`, role: "member" }).returning({ id: users.id });
  const expiresAt = new Date(Date.now() + 86_400_000);
  const [so] = await db.insert(sessions).values({ tenantId, userId: owner!.id, expiresAt }).returning({ id: sessions.id });
  const [sm] = await db.insert(sessions).values({ tenantId, userId: member!.id, expiresAt }).returning({ id: sessions.id });
  return { tenantId, slug, ownerId: owner!.id, ownerCookie: `claros_session=${so!.id}`, memberCookie: `claros_session=${sm!.id}` };
}

/** Insert a key of `kind` and return the raw value. */
export async function newKey(db: TestDb, tenantId: string, kind: "secret" | "publishable" | "admin", scopes: string[] | null = null): Promise<string> {
  const prefix = kind === "admin" ? "clr_ak_" : kind === "secret" ? "clr_sk_" : "clr_pk_";
  const raw = `${prefix}${randomBytes(32).toString("base64url")}`;
  await db.insert(apiKeys).values({ tenantId, keyHash: hashApiKey(raw), prefix: raw.slice(0, 8), kind, scopes });
  return raw;
}

export async function app(db: TestDb) {
  return buildApp({ db, logger: false, baseUrl: "http://localhost:3000", enqueue: async () => null });
}

export function bearer(raw: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${raw}`, "content-type": "application/json", ...extra };
}

export function cookieJson(cookie: string) {
  return { cookie, "content-type": "application/json" };
}

/** A contact, a flow, a membership and a message in `status`. */
export async function newMessage(
  db: TestDb,
  tenantId: string,
  opts: { status?: string; externalId?: string; email?: string | null; flowClass?: string; flowId?: string; contactId?: string } = {},
): Promise<{ messageId: string; contactId: string; flowId: string; membershipId: string }> {
  let contactId = opts.contactId;
  if (!contactId) {
    const ext = opts.externalId ?? `u-${randomUUID().slice(0, 8)}`;
    const [c] = await db
      .insert(contacts)
      .values({ tenantId, externalId: ext, email: opts.email === undefined ? `${ext}@example.com` : opts.email, lifecycleState: "signed_up" })
      .returning({ id: contacts.id });
    contactId = c!.id;
  }
  let flowId = opts.flowId;
  if (!flowId) {
    const [f] = await db
      .insert(flows)
      .values({
        tenantId,
        name: "Flow",
        triggerType: "manual",
        triggerConfig: {},
        steps: [{ order: 1, action_type: "welcome", delay: "0m", window_policy: "immediate" }],
        status: "active",
        flowClass: opts.flowClass ?? "nurture",
      })
      .returning({ id: flows.id });
    flowId = f!.id;
  }
  const [m] = await db
    .insert(flowMemberships)
    .values({ tenantId, contactId, flowId, status: "active", currentStep: 1, enteredAt: new Date() })
    .returning({ id: flowMemberships.id });
  const [msg] = await db
    .insert(lifecycleMessages)
    .values({
      tenantId,
      contactId,
      flowId,
      membershipId: m!.id,
      flowStepOrder: 1,
      status: opts.status ?? "pending_approval",
      subject: "Hello",
      bodyHtml: "<p>Hi</p>",
      bodyText: "Hi",
      brainActionType: "welcome",
    })
    .returning({ id: lifecycleMessages.id });
  return { messageId: msg!.id, contactId, flowId, membershipId: m!.id };
}

const PRODUCT_TABLES = [
  "webhook_outbox", "webhook_endpoints", "message_events", "lifecycle_messages", "flow_memberships",
  "contact_topics", "contact_conflicts", "lifecycle_transitions", "events", "suppressions", "kb_entries",
  "templates", "flows", "topics", "transport_configs", "contacts", "llm_configs", "scan_checkpoints",
  "retention_grid_snapshots", "api_keys", "sessions", "invites", "magic_link_tokens", "memberships", "users",
];

export async function dropProduct(db: TestDb, tenantId: string): Promise<void> {
  for (const table of PRODUCT_TABLES) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
}
