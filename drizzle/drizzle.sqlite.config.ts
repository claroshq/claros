/**
 * Drizzle configuration for the SQLite / Cloudflare D1 schema twin.
 *
 * Generate a migration after changing drizzle/schema-sqlite:
 *   npm run db:generate:sqlite
 * Migrations are applied by wrangler (`wrangler d1 migrations apply`) on
 * Workers, or by the D1 test harness locally.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./drizzle/schema-sqlite/*.ts",
  out: "./drizzle/migrations-sqlite",
  dialect: "sqlite",
});
