/**
 * Instance administration (instance admins only).
 *
 * Endpoints:
 *   GET /v1/instance                 { settings, users }
 *   PUT /v1/instance/settings/:key   { value } -> { key, value, updated_at }
 *
 * Instance settings are key/value JSON shared by every product of the
 * instance. Users are listed with their home product and memberships.
 */
import { z } from "zod";
import { storeFor } from "@claros/store";
import { createRouter, parseBody, requireInstanceAdmin } from "../http/router.js";
import type { Db } from "../plugins/db.js";

/** Setting keys: lowercase letters, digits, dot, underscore, hyphen; 1 to 64 characters. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const putSchema = z.object({ value: z.unknown() }).strict();

export default function instanceRoutes() {
  const app = createRouter();
  const body = parseBody();

  app.get("/", body, requireInstanceAdmin, async (c) => {
    const db: Db = c.var.db;
    const [settings, users] = await Promise.all([
      storeFor(db).apiInstance.listSettings(),
      storeFor(db).apiInstance.listUsers(),
    ]);
    return c.json({
      settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        instance_role: u.instanceRole,
        home_product_id: u.homeTenantId,
        deactivated: u.deactivatedAt !== null,
        created_at: u.createdAt?.toISOString() ?? null,
        memberships: u.memberships.map((m) => ({ product_id: m.tenantId, slug: m.slug, role: m.role })),
      })),
    });
  });

  app.put("/settings/:key", body, requireInstanceAdmin, async (c) => {
    const key = c.req.param("key")!;
    if (!KEY_PATTERN.test(key)) {
      return c.json({ error: "Invalid setting key." }, 400);
    }
    const parsed = putSchema.safeParse(c.var.body);
    if (!parsed.success || parsed.data.value === undefined || parsed.data.value === null) {
      return c.json({ error: "Body must be { \"value\": <JSON, not null> }." }, 400);
    }
    const db: Db = c.var.db;
    const row = await storeFor(db).apiInstance.putSetting({ key, value: parsed.data.value, now: new Date() });
    return c.json({ key: row.key, value: row.value, updated_at: row.updatedAt?.toISOString() ?? null });
  });

  return app;
}
