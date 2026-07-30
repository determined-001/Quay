import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

export type DB = LibSQLDatabase<typeof schema>;

// CREATE TABLE IF NOT EXISTS so a fresh clone runs with no migration step.
// (drizzle-kit push can manage this instead; see drizzle.config.ts.)
const BOOTSTRAP_SQL = [
  `CREATE TABLE IF NOT EXISTS sellers (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, wallet TEXT NOT NULL, created_at INTEGER NOT NULL
   )`,
  // New columns (offramp_indicative_rate, offramp_rate, offramp_rate_delta) are
  // included here so fresh databases get the full schema. Existing databases are
  // handled by the ALTER TABLE statements in MIGRATION_SQL below.
  `CREATE TABLE IF NOT EXISTS links (
     id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, seller_id TEXT NOT NULL,
     destination TEXT NOT NULL, muxed_id TEXT, title TEXT NOT NULL, amount TEXT NOT NULL,
     asset_code TEXT NOT NULL, asset_issuer TEXT, status TEXT NOT NULL,
     tx_hash TEXT, payer TEXT, paid_amount TEXT,
     offramp_job_id TEXT, offramp_target_currency TEXT, offramp_status TEXT,
     offramp_indicative_rate TEXT, offramp_rate TEXT, offramp_rate_delta TEXT,
     expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS webhooks (
     id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, url TEXT NOT NULL,
     secret TEXT NOT NULL, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
     id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, link_id TEXT NOT NULL,
     event TEXT NOT NULL, status_code INTEGER, ok INTEGER NOT NULL,
     error TEXT, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS offramp_quotes (
     quote_id TEXT PRIMARY KEY, link_id TEXT NOT NULL,
     sell_asset_code TEXT NOT NULL, sell_asset_issuer TEXT, sell_amount TEXT NOT NULL,
     buy_currency TEXT NOT NULL, price TEXT NOT NULL,
     expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS offramp_jobs (
     job_id TEXT PRIMARY KEY, link_id TEXT NOT NULL, anchor TEXT NOT NULL,
     target_currency TEXT NOT NULL, target_amount TEXT NOT NULL, rate TEXT NOT NULL,
     status TEXT NOT NULL, external_status TEXT, last_error TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS seller_kyc (
     seller_id TEXT PRIMARY KEY, customer_id TEXT, status TEXT NOT NULL,
     required_fields TEXT NOT NULL, fields_encrypted TEXT NOT NULL,
     message TEXT, last_synced_at INTEGER, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS watcher_cursors (
     account TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS processed_tx (
     tx_hash TEXT PRIMARY KEY, link_id TEXT, created_at INTEGER NOT NULL
   )`,
];

/**
 * Best-effort ALTER TABLE statements for existing databases that were created
 * before issue 3.5 added the three rate-telemetry columns. SQLite/libSQL throws
 * "duplicate column name" if the column already exists — we swallow that error
 * so the server can boot cleanly against both old and new schemas.
 */
const MIGRATION_SQL = [
  `ALTER TABLE links ADD COLUMN offramp_indicative_rate TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_rate TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_rate_delta TEXT`,
];

export function createDb(databaseUrl: string, authToken?: string): { db: DB; client: Client } {
  const client = createClient({ url: databaseUrl, authToken });
  const db = drizzle(client, { schema });
  return { db, client };
}

// Additive column added after the initial release. `CREATE TABLE IF NOT EXISTS`
// above won't touch an existing table, so add it out-of-band; ignore the
// "duplicate column" error on databases that already have it.
const MIGRATIONS_SQL = [`ALTER TABLE links ADD COLUMN muxed_id TEXT`];

export async function bootstrap(client: Client): Promise<void> {
  for (const sql of BOOTSTRAP_SQL) {
    await client.execute(sql);
  }
  for (const sql of MIGRATIONS_SQL) {
    try {
      await client.execute(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("duplicate column")) throw err;
    }
  }
}

export { schema };
