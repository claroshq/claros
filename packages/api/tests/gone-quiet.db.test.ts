/**
 * The API returns gone_quiet for the stored churned state (no data
 * migration: the database keeps churned, the API translates at its
 * boundary) and accepts both names in the People filter.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { contacts, lifecycleTransitions } from "@claros/db/schema";
import { openDb, newProduct, app as buildTestApp, dropProduct, cookieJson, type TestDb, type TestProduct } from "./support/product.js";
import type { ClarosApp } from "../src/app.js";

const BASE = "http://localhost:3000";

let pool: Awaited<ReturnType<typeof openDb>>["pool"];
let db: TestDb;
let a: ClarosApp;
let p: TestProduct;
let contactId: string;

async function get(path: string): Promise<Record<string, any>> {
  const res = await a.fetch(new Request(`${BASE}${path}`, { headers: cookieJson(p.ownerCookie) }));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

beforeAll(async () => {
  ({ pool, db } = openDb());
  a = await buildTestApp(db);
  p = await newProduct(db, "gonequiet");
  const now = new Date();
  const [c] = await db
    .insert(contacts)
    .values({ tenantId: p.tenantId, externalId: "gq-1", email: "gq-1@example.com", lifecycleState: "churned", firstSeenAt: now, lastSeenAt: now })
    .returning({ id: contacts.id });
  contactId = c!.id;
  await db.insert(contacts).values({ tenantId: p.tenantId, externalId: "gq-2", lifecycleState: "engaged", firstSeenAt: now, lastSeenAt: now });
  await db.insert(lifecycleTransitions).values({ tenantId: p.tenantId, contactId, fromState: "dormant", toState: "churned", transitionedAt: now });
});

afterAll(async () => {
  await dropProduct(db, p.tenantId);
  await pool.end();
});

describe("gone_quiet in API responses", () => {
  it("lists the contact as gone_quiet and filters by either name", async () => {
    for (const name of ["gone_quiet", "churned"]) {
      const body = await get(`/v1/contacts?lifecycle_state=${name}`);
      expect(body.contacts.map((c: { external_id: string }) => c.external_id)).toEqual(["gq-1"]);
      expect(body.contacts[0].lifecycle_state).toBe("gone_quiet");
    }
  });

  it("returns gone_quiet in the detail and the timeline", async () => {
    const detail = await get(`/v1/contacts/${contactId}`);
    expect(detail.contact.lifecycle_state).toBe("gone_quiet");
    const timeline = await get(`/v1/contacts/${contactId}/timeline`);
    const t = timeline.items.find((i: { to_state?: string | null }) => i.to_state);
    expect(t).toMatchObject({ from_state: "dormant", to_state: "gone_quiet" });
  });

  it("returns gone_quiet in lifecycle analytics", async () => {
    const body = await get("/v1/analytics/lifecycle?days=30");
    const states = body.distribution.map((r: { state: string }) => r.state);
    expect(states).toContain("gone_quiet");
    expect(states).not.toContain("churned");
    expect(body.movement.edges).toContainEqual(expect.objectContaining({ from_state: "dormant", to_state: "gone_quiet" }));
    expect(body.movement.per_state.map((r: { state: string }) => r.state)).not.toContain("churned");
  });
});
