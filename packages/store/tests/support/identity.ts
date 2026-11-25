/**
 * Fixtures for the identity areas (users, memberships, sessions, tenants)
 * shared by the session/auth/claim/invite/team/profile/products/instance
 * contract tests. Emails are unique per call, since some lookups are global.
 */
import { randomUUID } from "node:crypto";
import type { Backend } from "./backends.js";

export const uniqueEmail = (tag = "u") => `${tag}-${randomUUID().slice(0, 12)}@example.com`;

export async function addUser(b: Backend, tenantId: string, values: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.users).values({ id, tenantId, email: uniqueEmail(), role: "member", ...values });
  return id;
}

export async function addMembership(b: Backend, userId: string, tenantId: string, role: string): Promise<void> {
  await b.db.insert(b.schema.memberships).values({ userId, tenantId, role });
}

export async function addSession(b: Backend, tenantId: string, userId: string, expiresAt = new Date(Date.now() + 86_400_000)): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.sessions).values({ id, tenantId, userId, expiresAt });
  return id;
}

/** Insert a tenant with explicit values; returns its id and slug. */
export async function addTenant(b: Backend, values: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
  const id = randomUUID();
  const slug = (values.slug as string | undefined) ?? `t-${id.slice(0, 8)}`;
  await b.db.insert(b.schema.tenants).values({ id, name: "T", slug, ...values });
  return { id, slug };
}

export async function addTransport(b: Backend, tenantId: string, values: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.transportConfigs).values({
    id,
    tenantId,
    provider: "resend",
    config: { apiKey: "k", nested: { a: 1 } },
    fromEmail: "from@example.com",
    fromName: "From",
    isActive: true,
    ...values,
  });
  return id;
}
