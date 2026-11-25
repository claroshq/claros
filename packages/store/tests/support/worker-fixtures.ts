/**
 * Fixture inserts shared by the worker-area contract tests. Every helper
 * works on both backends (same schema property names) and returns the id.
 */
import { randomUUID } from "node:crypto";
import type { Backend } from "./backends.js";

export async function insertContact(
  b: Backend,
  tenantId: string,
  values: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.contacts).values({
    id,
    tenantId,
    externalId: `ext-${id}`,
    lifecycleState: "signed_up",
    ...values,
  });
  return id;
}

export async function insertFlow(
  b: Backend,
  tenantId: string,
  values: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.flows).values({
    id,
    tenantId,
    name: `flow-${id.slice(0, 8)}`,
    triggerType: "event",
    triggerConfig: { event: "x" },
    steps: [],
    status: "active",
    ...values,
  });
  return id;
}

export async function insertMembership(
  b: Backend,
  values: { tenantId: string; contactId: string; flowId: string } & Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.flowMemberships).values({
    id,
    currentStep: 1,
    status: "active",
    enteredAt: new Date("2026-11-01T00:00:00Z"),
    ...values,
  });
  return id;
}

export async function insertMessage(
  b: Backend,
  values: {
    tenantId: string;
    contactId: string;
    flowId: string;
    membershipId: string;
  } & Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.lifecycleMessages).values({
    id,
    status: "pending_generation",
    ...values,
  });
  return id;
}

export async function insertEvent(
  b: Backend,
  values: { tenantId: string; contactId: string; timestamp: Date } & Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await b.db.insert(b.schema.events).values({
    id,
    type: "track",
    receivedAt: values.timestamp,
    ...values,
  });
  return id;
}

/** Sort rows by id (for comparing unordered results across backends). */
export function byId<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Ids sorted the way both backends order uuids (lowercase hex string order). */
export function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}
