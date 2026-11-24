/**
 * Drizzle configuration for community schema.
 *
 * For migrations: use `npm run db:migrate`, which reads DATABASE_URL by default
 * (local) or PRODUCTION_DATABASE_URL with --prod (a remote database). The script exports the
 * resolved URL as DATABASE_URL before invoking drizzle-kit.
 *
 * For generate, studio, check: DATABASE_URL is sufficient.
 */
import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "No database URL found. Set DATABASE_URL in .env or your environment."
  );
}

export default defineConfig({
  schema: "./drizzle/schema/*.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
});
