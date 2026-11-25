-- Case-insensitive suppression uniqueness, the SQLite twin of Postgres
-- migration 0013: a unique expression index on (tenant_id, lower(email)).
-- Drizzle-kit cannot express this index in the schema DSL, so it lives here
-- only (see drizzle/schema-sqlite/suppressions.ts).
--
-- Step 1: delete case-variant duplicates, keeping the oldest row per
-- (tenant_id, lower(email)) (same rule as Postgres 0013; rows without
-- created_at sort last, ties broken by id).
DELETE FROM `suppressions`
WHERE `id` NOT IN (
  SELECT `id` FROM (
    SELECT `id`, ROW_NUMBER() OVER (
      PARTITION BY `tenant_id`, lower(`email`)
      ORDER BY `created_at` IS NULL, `created_at` ASC, `id` ASC
    ) AS `rn`
    FROM `suppressions`
  )
  WHERE `rn` = 1
);
--> statement-breakpoint
-- Step 2: the unique expression index (lower() folds ASCII only on SQLite).
CREATE UNIQUE INDEX `uq_suppressions_tenant_email_lower` ON `suppressions` (`tenant_id`, lower(`email`));
