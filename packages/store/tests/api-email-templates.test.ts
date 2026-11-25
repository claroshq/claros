/**
 * Contract tests for apiEmailTemplates (packages/api/src/routes/email-templates.ts) on every backend.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testBackends, type Backend } from "./support/backends.js";

for (const factory of testBackends()) {
  describe(`apiEmailTemplates on ${factory.name}`, () => {
    let b: Backend;
    beforeAll(async () => {
      b = await factory.open();
    }, 60_000);
    afterAll(async () => {
      await b.close();
    });

    const q = () => b.store.apiEmailTemplates;

    async function insertTemplate(tenantId: string, slug: string, extra: Record<string, unknown> = {}) {
      const [row] = await b.db
        .insert(b.schema.templates)
        .values({
          tenantId, name: `T ${slug}`, slug, subject: "Hi", bodyHtml: "<p>Hi</p>", bodyText: "Hi",
          variables: ["first_name"], category: "nurture", ...extra,
        })
        .returning({ id: b.schema.templates.id });
      return row.id as string;
    }

    it("lists the tenant's templates", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const a = await insertTemplate(t, "a");
      const c = await insertTemplate(t, "c", { bodyText: null, variables: null, category: null, isActive: false });
      await insertTemplate(other, "a");
      const rows = await q().listTemplates({ tenantId: t });
      expect(rows).toHaveLength(2);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(a)).toMatchObject({
        name: "T a", slug: "a", subject: "Hi", bodyHtml: "<p>Hi</p>", bodyText: "Hi",
        variables: ["first_name"], category: "nurture", isActive: true,
      });
      expect(byId.get(a)!.createdAt).toBeInstanceOf(Date);
      expect(byId.get(c)).toMatchObject({ bodyText: null, variables: null, category: null, isActive: false });
      expect(Object.keys(rows[0]!).sort()).toEqual(
        ["bodyHtml", "bodyText", "category", "createdAt", "id", "isActive", "name", "slug", "subject", "variables"],
      );
      expect(await q().listTemplates({ tenantId: await b.newTenant() })).toEqual([]);
    });

    it("gets one template of the tenant", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const id = await insertTemplate(t, "a");
      const got = await q().getTemplate({ tenantId: t, id });
      expect(got).toMatchObject({ id, slug: "a" });
      expect(await q().getTemplate({ tenantId: other, id })).toBeNull();
      expect(await q().getTemplate({ tenantId: t, id: "00000000-0000-4000-8000-000000000000" })).toBeNull();
    });

    it("updates only the given fields of the tenant's template", async () => {
      const t = await b.newTenant();
      const other = await b.newTenant();
      const id = await insertTemplate(t, "a");
      const updated = await q().updateTemplate({ tenantId: t, id, updates: { subject: "New", bodyText: null } });
      expect(updated).toMatchObject({ id, subject: "New", bodyHtml: "<p>Hi</p>", bodyText: null, name: "T a" });
      expect(await q().getTemplate({ tenantId: t, id })).toEqual(updated);

      const again = await q().updateTemplate({ tenantId: t, id, updates: { bodyHtml: "<b>x</b>" } });
      expect(again).toMatchObject({ subject: "New", bodyHtml: "<b>x</b>" });

      expect(await q().updateTemplate({ tenantId: other, id, updates: { subject: "Hijack" } })).toBeNull();
      expect((await q().getTemplate({ tenantId: t, id }))!.subject).toBe("New");
    });
  });
}
