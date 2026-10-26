import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: { url: process.env.DATABASE_URL ?? "file:./local.db" },
  // Use sequential numeric prefixes (0000, 0001, …) for deterministic ordering.
  migrations: { prefix: "index" },
} satisfies Config;
