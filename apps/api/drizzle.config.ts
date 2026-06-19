import type { Config } from "drizzle-kit";

// Optional: `pnpm --filter @checkout/api db:push` to manage the schema with
// drizzle-kit. The app also self-initializes its tables on boot (see db/client.ts),
// so this is not required to run the MVP.
export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: { url: process.env.DATABASE_URL ?? "file:./local.db" },
} satisfies Config;
