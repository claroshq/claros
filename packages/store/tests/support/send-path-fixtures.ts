/**
 * Fixtures for the send-path contract tests (worker content, drain, reap, ...).
 * Every insert goes through the backend's Drizzle handle with the shared schema names.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Backend } from "./backends.js";

export async function seedContact(
  b: Backend,
  tenantId: string,
  values: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.contacts).values({
    id,
    tenantId,
    externalId: `ext-${id.slice(0, 8)}`,
    email: `${id.slice(0, 8)}@example.com`,
    lifecycleState: "signed_up",
    ...values,
  });
  return id;
}

export async function seedFlow(
  b: Backend,
  tenantId: string,
  values: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.flows).values({
    id,
    tenantId,
    name: `Flow ${id.slice(0, 8)}`,
    triggerType: "manual",
    triggerConfig: {},
    steps: [],
    ...values,
  });
  return id;
}

let stepCounter = 0;

export interface SeedMessageInput {
  tenantId: string;
  status: string;
  contactId?: string;
  flowId?: string;
  [column: string]: unknown;
}

/** Insert a lifecycle message (creating contact, flow and membership as needed); returns its id. */
export async function seedMessage(b: Backend, input: SeedMessageInput): Promise<string> {
  const { tenantId, contactId: c, flowId: f, ...rest } = input;
  const contactId = c ?? (await seedContact(b, tenantId));
  const flowId = f ?? (await seedFlow(b, tenantId));
  const membershipId = randomUUID();
  await b.db.insert(b.schema.flowMemberships).values({
    id: membershipId,
    tenantId,
    contactId,
    flowId,
    // A finished membership: avoids the one-active-membership-per-flow index.
    status: "completed",
    enteredAt: new Date("2025-01-01T00:00:00Z"),
  });
  const id = randomUUID();
  await b.db.insert(b.schema.lifecycleMessages).values({
    id,
    tenantId,
    contactId,
    flowId,
    membershipId,
    flowStepOrder: ++stepCounter,
    ...rest,
  });
  return id;
}

/** The lifecycle message row (shared schema property names). */
export async function getMessage(b: Backend, id: string): Promise<any> {
  const rows = await b.db
    .select()
    .from(b.schema.lifecycleMessages)
    .where(eq(b.schema.lifecycleMessages.id, id));
  return rows[0] ?? null;
}

/** Sorted copy, for comparing id sets whose order is not part of the contract. */
export function sorted<T>(xs: T[]): T[] {
  return [...xs].sort();
}
