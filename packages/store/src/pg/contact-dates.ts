/**
 * Postgres: keep contact_dates (G3) in step with the declared date traits of
 * contacts' properties. Used by identify (one contact) and by config apply
 * (reindex of a product after settings.date_traits changes).
 */
import { sql } from "drizzle-orm";
import { parseDateValue } from "@claros/core";
import type { PgDb } from "./db.js";

/**
 * Rewrite the contact_dates rows of the given contacts for `properties`:
 * upsert parseable values, delete the rest (and rows of properties that are
 * no longer declared).
 */
export async function pgSyncContactDates(
  db: PgDb,
  tenantId: string,
  rows: ReadonlyArray<{ id: string; properties: unknown }>,
  properties: readonly string[],
  now: Date,
): Promise<number> {
  let written = 0;
  for (const row of rows) {
    const props = row.properties && typeof row.properties === "object" ? (row.properties as Record<string, unknown>) : {};
    const keep: string[] = [];
    for (const p of properties) {
      const d = parseDateValue(props[p]);
      if (!d) continue;
      keep.push(p);
      await db.execute(sql`
        INSERT INTO contact_dates (tenant_id, contact_id, property, value, updated_at)
        VALUES (${tenantId}::uuid, ${row.id}::uuid, ${p}, ${d}, ${now})
        ON CONFLICT (tenant_id, contact_id, property)
        DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
        WHERE contact_dates.value IS DISTINCT FROM EXCLUDED.value
      `);
      written++;
    }
    await db.execute(sql`
      DELETE FROM contact_dates
      WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${row.id}::uuid
        ${keep.length > 0 ? sql`AND property NOT IN (${sql.join(keep.map((k) => sql`${k}`), sql`, `)})` : sql``}
    `);
  }
  return written;
}

/** Re-index every contact of a product (keyset pages of 500). */
export async function pgReindexContactDates(db: PgDb, tenantId: string, properties: readonly string[], now: Date): Promise<number> {
  if (properties.length === 0) {
    await db.execute(sql`DELETE FROM contact_dates WHERE tenant_id = ${tenantId}::uuid`);
    return 0;
  }
  let after: string | null = null;
  let written = 0;
  for (;;) {
    const res: { rows: Array<{ id: string; properties: unknown }> } = await db.execute<{ id: string; properties: unknown }>(sql`
      SELECT id, properties FROM contacts
      WHERE tenant_id = ${tenantId}::uuid ${after ? sql`AND id > ${after}::uuid` : sql``}
      ORDER BY id LIMIT 500
    `);
    if (res.rows.length === 0) break;
    written += await pgSyncContactDates(db, tenantId, res.rows, properties, now);
    after = res.rows[res.rows.length - 1]!.id;
    if (res.rows.length < 500) break;
  }
  return written;
}
