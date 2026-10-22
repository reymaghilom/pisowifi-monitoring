/* drizzle-kit configuration, used for `db:generate` and `db:check` (offline). Apply migrations with
   `npm run db:migrate` (TLS-verified, migration credentials), not `drizzle-kit migrate` or `push`. */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
