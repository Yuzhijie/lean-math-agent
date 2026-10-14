/**
 * Prisma 7 CLI configuration (generate / db push / migrate).
 * Prisma 7 no longer reads .env files itself; Next.js keeps settings in .env.local.
 */
import { defineConfig } from "prisma/config";
import { sqliteUrl } from "./lib/db-url";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    /* file absent */
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: sqliteUrl() },
});
