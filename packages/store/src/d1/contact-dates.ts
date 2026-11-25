/**
 * SQLite / D1: keep contact_dates (G3) in step with the declared date traits
 * of contacts' properties. See ../pg/contact-dates.ts. Each contact's rows
 * are rewritten in one batch.
 */
import { sql, type SQL } from "drizzle-orm";
import { parseDateValue } from "@claros/core";
import type { D1Db } from "./db.js";
import { rawBatch } from "./raw-batch.js";

export async function d1SyncContactDates(
  db: D1Db,
  tenantId: string,
  rows: ReadonlyArray<{ id: string; properties: unknown }>,
  properties: readonly string[],
  now: Date,
): Promise<number> {
  let written = 0;
  for (const row of rows) {
    let props: Record<string, unknown> = {};
    if (typeof row.properties === "string") {
      try {
        props = JSON.parse(row.properties) as Record<string, unknown>;
      } catch {
        props = {};
      }
    } else if (row.properties && typeof row.properties === "object") {
      props = row.properties as Record<string, unknown>;
    }
    const keep: string[] = [];
    const statements: SQL[] = [];
    for (const p of properties) {
      const d = parseDateValue(props[p]);
      if (!d) continue;
      keep.push(p);
      statements.push(sql`
        INSERT INTO contact_dates (tenant_id, contact_id, property, value, updated_at)
        VALUES (${tenantId}, ${row.id}, ${p}, ${d.getTime()}, ${now.getTime()})
        ON CONFLICT (tenant_id, contact_id, property)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        WHERE contact_dates.value IS NOT excluded.value
      `);
      written++;
    }
    statements.push(sql`
      DELETE FROM contact_dates
      WHERE tenant_id = ${tenantId} AND contact_id = ${row.id}
        ${keep.length > 0 ? sql`AND property NOT IN (${sql.join(keep.map((k) => sql`${k}`), sql`, `)})` : sql``}
    `);
    await rawBatch(db, statements);
  }
  return written;
}

export async function d1ReindexContactDates(db: D1Db, tenantId: string, properties: readonly string[], now: Date): Promise<number> {
  if (properties.length === 0) {
    await db.run(sql`DELETE FROM contact_dates WHERE tenant_id = ${tenantId}`);
    return 0;
  }
  let after: string | null = null;
  let written = 0;
  for (;;) {
    const rows: Array<{ id: string; properties: unknown }> = await db.all<{ id: string; properties: unknown }>(sql`
      SELECT id, properties FROM contacts
      WHERE tenant_id = ${tenantId} ${after ? sql`AND id > ${after}` : sql``}
      ORDER BY id LIMIT 500
    `);
    if (rows.length === 0) break;
    written += await d1SyncContactDates(db, tenantId, rows, properties, now);
    after = rows[rows.length - 1]!.id;
    if (rows.length < 500) break;
  }
  return written;
}
