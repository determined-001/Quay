import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { encryptSecret, last4 } from "../services/secret-crypto";
import { runMigrations, type RunMigrationsOptions } from "./migrate";

export type DB = LibSQLDatabase<typeof schema>;

export function createDb(databaseUrl: string, authToken?: string): { db: DB; client: Client } {
  const client = createClient({ url: databaseUrl, authToken });
  const db = drizzle(client, { schema });
  return { db, client };
}

// ---------------------------------------------------------------------------
// Legacy structural migrations
//
// These helpers fix database shapes that predate Drizzle-managed migrations.
// They run before `runMigrations()` so that the Drizzle journal can be applied
// cleanly to databases created under the old bootstrap() path.
//
// Each helper is idempotent: it inspects the actual table shape and is a no-op
// on a fresh database or one that has already been upgraded.
// ---------------------------------------------------------------------------

/**
 * Additive column migrations for databases created before Drizzle took over.
 * These are the ALTER TABLE ADD COLUMN statements that used to live in
 * ADDITIVE_MIGRATIONS in the old bootstrap(). They are kept here so that any
 * existing database missing these columns gets them added before the Drizzle
 * baseline is stamped and migrate() runs. On a fresh database (no tables yet)
 * these are all no-ops because the baseline migration creates every table with
 * the full column set.
 *
 * "duplicate column" errors are swallowed — that means the column already
 * exists, which is what we want.
 */
async function applyAdditiveMigrations(client: Client): Promise<void> {
  const additive = [
    `ALTER TABLE offramp_quotes ADD COLUMN withdraw_type TEXT`,
    `ALTER TABLE offramp_quotes ADD COLUMN quoted_rate TEXT`,
    `ALTER TABLE offramp_quotes ADD COLUMN quoted_target_amount TEXT`,
    `ALTER TABLE offramp_quotes ADD COLUMN quoted_fee_amount TEXT`,
    `ALTER TABLE offramp_quotes ADD COLUMN quoted_fee_source TEXT`,
    `ALTER TABLE offramp_quotes ADD COLUMN quoted_net_target_amount TEXT`,
    `ALTER TABLE offramp_quotes ADD COLUMN quoted_kind TEXT`,
    `ALTER TABLE links ADD COLUMN offramp_indicative_rate TEXT`,
    `ALTER TABLE links ADD COLUMN offramp_rate TEXT`,
    `ALTER TABLE links ADD COLUMN offramp_rate_delta TEXT`,
    `ALTER TABLE links ADD COLUMN overpaid_amount TEXT`,
    `ALTER TABLE links ADD COLUMN muxed_id TEXT`,
    `ALTER TABLE links ADD COLUMN offramp_fee_amount TEXT`,
    `ALTER TABLE links ADD COLUMN offramp_fee_currency TEXT`,
    `ALTER TABLE links ADD COLUMN offramp_fee_source TEXT`,
    `ALTER TABLE links ADD COLUMN offramp_net_target_amount TEXT`,
    `ALTER TABLE links ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE sellers ADD COLUMN payout_fields_json TEXT`,
    `ALTER TABLE sellers ADD COLUMN payout_fields_encrypted TEXT`,
    `ALTER TABLE sellers ADD COLUMN profile_kind TEXT NOT NULL DEFAULT 'individual'`,
    `ALTER TABLE link_payments ADD COLUMN ledger INTEGER`,
    `ALTER TABLE offramp_jobs ADD COLUMN seller_id TEXT`,
    `ALTER TABLE offramp_jobs ADD COLUMN account TEXT`,
    `ALTER TABLE offramp_jobs ADD COLUMN sell_asset_code TEXT`,
    `ALTER TABLE offramp_jobs ADD COLUMN sell_asset_issuer TEXT`,
    `ALTER TABLE offramp_jobs ADD COLUMN sell_amount TEXT`,
    `ALTER TABLE offramp_jobs ADD COLUMN transfer_json TEXT`,
    `ALTER TABLE offramp_jobs ADD COLUMN last_poll_error TEXT`,
    `ALTER TABLE offramp_jobs ADD COLUMN last_poll_error_at INTEGER`,
    `ALTER TABLE offramp_jobs ADD COLUMN last_poll_reason TEXT`,
    `ALTER TABLE seller_kyc ADD COLUMN account TEXT`,
    `ALTER TABLE sellers ADD COLUMN last_active_at INTEGER`,
    `ALTER TABLE offramp_jobs ADD COLUMN transfer_notified_at INTEGER`,
    `ALTER TABLE offramp_jobs ADD COLUMN seller_tx_hash TEXT`,
    `ALTER TABLE offramp_jobs ADD COLUMN amount_in TEXT`,
    `ALTER TABLE offramp_jobs ADD COLUMN amount_fee TEXT`,
    `ALTER TABLE offramp_jobs ADD COLUMN stellar_transaction_id TEXT`,
    `ALTER TABLE seller_kyc ADD COLUMN callback_token_hash TEXT`,
    `CREATE INDEX IF NOT EXISTS seller_kyc_callback_token_hash_idx ON seller_kyc (callback_token_hash)`,
    // BUG-4.21: ensure sellers.wallet is unique so ON CONFLICT works.
    `CREATE UNIQUE INDEX IF NOT EXISTS sellers_wallet_unique ON sellers (wallet)`,
    `ALTER TABLE seller_kyc ADD COLUMN provided_field_status TEXT`,
    `ALTER TABLE seller_kyc ADD COLUMN sent_fields TEXT`,
  ];

  for (const sql of additive) {
    try {
      await client.execute(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "duplicate column" / "already exists" → column already there, skip.
      // "no such table" → fresh database, table doesn't exist yet; the
      //   baseline migration will create it with the full column set, skip.
      if (
        msg.toLowerCase().includes("duplicate column") ||
        msg.includes("already exists") ||
        msg.toLowerCase().includes("no such table")
      ) continue;
      throw err;
    }
  }
}

/**
 * Upgrades a `webhooks` table created before the secret-rotation feature
 * (plaintext `secret` column, no lifecycle columns) in place. Only runs its
 * ALTERs if the old shape is actually detected, so it's a no-op on fresh
 * databases (which get the current shape directly from migrations) and on
 * databases already upgraded.
 *
 * The plaintext `secret` column is intentionally left in place rather than
 * dropped — DROP COLUMN support varies across older SQLite builds, and
 * leaving an unused column is harmless. New code never reads it.
 */
async function migrateLegacyWebhooksTable(client: Client): Promise<void> {
  const info = await client.execute("PRAGMA table_info(webhooks)");
  const columns = new Set(info.rows.map((r) => String(r.name)));
  if (columns.size === 0 || columns.has("secret_encrypted")) return; // fresh table, or already migrated

  for (const [name, ddl] of [
    ["secret_encrypted", "ALTER TABLE webhooks ADD COLUMN secret_encrypted TEXT"],
    ["secret_last4", "ALTER TABLE webhooks ADD COLUMN secret_last4 TEXT"],
    ["previous_secret_encrypted", "ALTER TABLE webhooks ADD COLUMN previous_secret_encrypted TEXT"],
    ["previous_secret_last4", "ALTER TABLE webhooks ADD COLUMN previous_secret_last4 TEXT"],
    ["previous_secret_expires_at", "ALTER TABLE webhooks ADD COLUMN previous_secret_expires_at INTEGER"],
    ["deleted_at", "ALTER TABLE webhooks ADD COLUMN deleted_at INTEGER"],
  ] as const) {
    if (!columns.has(name)) await client.execute(ddl);
  }

  if (columns.has("secret")) {
    const rows = await client.execute("SELECT id, secret FROM webhooks WHERE secret_encrypted IS NULL");
    for (const row of rows.rows) {
      const plaintext = String(row.secret ?? "");
      if (!plaintext) continue;
      await client.execute({
        sql: "UPDATE webhooks SET secret_encrypted = ?, secret_last4 = ? WHERE id = ?",
        args: [encryptSecret(plaintext), last4(plaintext), String(row.id)],
      });
    }
  }
}

/**
 * Rebuilds `processed_tx` around (tx_hash, operation_id) instead of tx_hash
 * alone (issue 4.11). SQLite can't ALTER a column into/out of a PRIMARY KEY,
 * and the whole point here is that tx_hash must stop being unique by itself —
 * two payment operations sharing one transaction need two rows — so this is a
 * rename/recreate/copy/drop, not an ADD COLUMN. Legacy rows get
 * operation_id = NULL, which `DrizzleWatcherStateRepository.isProcessed`
 * treats as "the whole transaction was processed", preserving exactly the
 * dedup behavior anything already settled before this migration runs had.
 *
 * No-op on a fresh database (migrations create the current shape directly)
 * and on a database already migrated.
 */
async function migrateLegacyProcessedTxTable(client: Client): Promise<void> {
  const info = await client.execute("PRAGMA table_info(processed_tx)");
  const columns = new Set(info.rows.map((r) => String(r.name)));
  if (columns.size === 0 || columns.has("operation_id")) return; // fresh table, or already migrated

  await client.execute("ALTER TABLE processed_tx RENAME TO processed_tx_legacy_4_11");
  await client.execute(`CREATE TABLE processed_tx (
     tx_hash TEXT NOT NULL, operation_id TEXT, link_id TEXT, created_at INTEGER NOT NULL,
     PRIMARY KEY (tx_hash, operation_id)
   )`);
  await client.execute("CREATE INDEX IF NOT EXISTS processed_tx_tx_hash_idx ON processed_tx (tx_hash)");
  await client.execute(
    `INSERT INTO processed_tx (tx_hash, operation_id, link_id, created_at)
     SELECT tx_hash, NULL, link_id, created_at FROM processed_tx_legacy_4_11`,
  );
  await client.execute("DROP TABLE processed_tx_legacy_4_11");
}

/**
 * Same rebuild as `migrateLegacyProcessedTxTable`, for `link_payments` (issue
 * 4.11): the unique constraint moves from tx_hash alone to
 * (tx_hash, operation_id), so a split payment's second operation gets its own
 * ledger row instead of being silently dropped by `onConflictDoNothing`.
 * Legacy rows get operation_id = NULL; unlike processed_tx, nothing reads
 * link_payments as a dedup gate, so NULL there carries no special meaning —
 * it just fills the new column on rows written before it existed.
 */
async function migrateLegacyLinkPaymentsTable(client: Client): Promise<void> {
  const info = await client.execute("PRAGMA table_info(link_payments)");
  const columns = new Set(info.rows.map((r) => String(r.name)));
  if (columns.size === 0 || columns.has("operation_id")) return; // fresh table, or already migrated

  // `ledger` (issue 9.2) may or may not be present yet depending on how old
  // this particular database is — don't assume either way, select it if it's
  // there and NULL otherwise, same as `operation_id` always being NULL here.
  const ledgerSelect = columns.has("ledger") ? "ledger" : "NULL";

  await client.execute("ALTER TABLE link_payments RENAME TO link_payments_legacy_4_11");
  await client.execute(`CREATE TABLE link_payments (
     id TEXT PRIMARY KEY, link_id TEXT NOT NULL, tx_hash TEXT NOT NULL,
     operation_id TEXT,
     payer TEXT NOT NULL, amount TEXT NOT NULL,
     asset_code TEXT NOT NULL, asset_issuer TEXT, ledger INTEGER,
     created_at INTEGER NOT NULL
   )`);
  await client.execute("CREATE INDEX IF NOT EXISTS link_payments_link_id_idx ON link_payments (link_id)");
  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS link_payments_tx_hash_operation_id_unique
       ON link_payments (tx_hash, operation_id)`,
  );
  await client.execute(
    `INSERT INTO link_payments (id, link_id, tx_hash, operation_id, payer, amount, asset_code, asset_issuer, ledger, created_at)
     SELECT id, link_id, tx_hash, NULL, payer, amount, asset_code, asset_issuer, ${ledgerSelect}, created_at
     FROM link_payments_legacy_4_11`,
  );
  await client.execute("DROP TABLE link_payments_legacy_4_11");
}

/**
 * Backfill `last_active_at` on existing sellers that do not have it populated.
 * Uses the latest activity timestamp across links, seller_kyc, anchor_sessions,
 * and api_keys, falling back to sellers.created_at.
 *
 * Skips any sub-query for a table that does not exist yet (possible on partial
 * legacy test fixtures that only have a subset of tables).
 */
async function backfillSellerLastActiveAt(client: Client): Promise<void> {
  const sellersInfo = await client.execute("PRAGMA table_info(sellers)");
  const sellersCols = new Set(sellersInfo.rows.map((r) => String(r.name)));
  if (!sellersCols.has("last_active_at")) return;

  // Determine which auxiliary tables actually exist in this database.
  const aux = ["links", "seller_kyc", "anchor_sessions", "api_keys"];
  const existing = new Set<string>();
  for (const t of aux) {
    const r = await client.execute({
      sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
      args: [t],
    });
    if (r.rows.length > 0) existing.add(t);
  }

  const unions: string[] = [];
  if (existing.has("links"))
    unions.push("SELECT created_at AS val FROM links WHERE seller_id = sellers.id");
  if (existing.has("seller_kyc"))
    unions.push("SELECT updated_at AS val FROM seller_kyc WHERE seller_id = sellers.id");
  if (existing.has("anchor_sessions"))
    unions.push("SELECT created_at AS val FROM anchor_sessions WHERE seller_id = sellers.id");
  if (existing.has("api_keys"))
    unions.push("SELECT last_used_at AS val FROM api_keys WHERE seller_id = sellers.id AND last_used_at IS NOT NULL");

  if (unions.length === 0) return; // nothing to backfill from

  await client.execute(`
    UPDATE sellers
    SET last_active_at = COALESCE(
      (SELECT MAX(val) FROM (${unions.join(" UNION ALL ")})),
      created_at
    )
    WHERE last_active_at IS NULL
  `);
}

/**
 * Rebuilds `webhook_queue` so `link_id` is nullable (allowing seller-level events).
 */
async function migrateLegacyWebhookQueueTable(client: Client): Promise<void> {
  const info = await client.execute("PRAGMA table_info(webhook_queue)");
  const linkIdCol = info.rows.find((r) => String(r.name) === "link_id");
  if (linkIdCol && Number(linkIdCol.notnull) === 1) {
    await client.execute("ALTER TABLE webhook_queue RENAME TO webhook_queue_legacy_4_30");
    await client.execute(`CREATE TABLE webhook_queue (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      link_id TEXT,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      last_status_code INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    await client.execute("CREATE INDEX IF NOT EXISTS idx_webhook_queue_due ON webhook_queue (status, next_attempt_at)");
    await client.execute("INSERT INTO webhook_queue SELECT * FROM webhook_queue_legacy_4_30");
    await client.execute("DROP TABLE webhook_queue_legacy_4_30");
  }
}

/**
 * Rebuilds `webhook_deliveries` so `link_id` is nullable (allowing seller-level events).
 */
async function migrateLegacyWebhookDeliveriesTable(client: Client): Promise<void> {
  const info = await client.execute("PRAGMA table_info(webhook_deliveries)");
  const linkIdCol = info.rows.find((r) => String(r.name) === "link_id");
  if (linkIdCol && Number(linkIdCol.notnull) === 1) {
    await client.execute("ALTER TABLE webhook_deliveries RENAME TO webhook_deliveries_legacy_4_30");
    await client.execute(`CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, link_id TEXT,
      event TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
      queue_entry_id TEXT,
      status_code INTEGER, ok INTEGER NOT NULL,
      error TEXT, created_at INTEGER NOT NULL
    )`);
    await client.execute("CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_id_created_at_idx ON webhook_deliveries (webhook_id, created_at DESC)");
    await client.execute("INSERT INTO webhook_deliveries SELECT * FROM webhook_deliveries_legacy_4_30");
    await client.execute("DROP TABLE webhook_deliveries_legacy_4_30");
  }
}

/** Marks a `seller_kyc` row that predates per-anchor keys and cannot be attributed to an anchor. */
export const LEGACY_KYC_ANCHOR = "legacy";

/**
 * Issue 4.24: `seller_kyc` was keyed by seller alone, so a second anchor would
 * overwrite the first's state and inherit its customer id. SQLite cannot change
 * a primary key in place, so rebuild: create `seller_kyc_v2` keyed by
 * (seller_id, anchor_domain), copy every row, drop, rename.
 *
 * Existing rows are attributed to `anchorDomain` (the currently configured
 * anchor's home domain). With no real anchor configured they cannot be
 * attributed and keep {@link LEGACY_KYC_ANCHOR}, whose rows are never reused for
 * a customer id. Idempotent: a table that already has `anchor_domain` is left alone.
 */
async function migrateLegacySellerKycTable(client: Client, anchorDomain: string | null): Promise<void> {
  const info = await client.execute("PRAGMA table_info(seller_kyc)");
  const columns = new Set(info.rows.map((r) => String(r.name)));
  if (columns.size === 0 || columns.has("anchor_domain")) return; // fresh table, or already migrated

  await client.execute("DROP TABLE IF EXISTS seller_kyc_v2");
  await client.execute(`CREATE TABLE seller_kyc_v2 (
     seller_id TEXT NOT NULL, anchor_domain TEXT NOT NULL,
     account TEXT, customer_id TEXT, status TEXT NOT NULL,
     required_fields TEXT NOT NULL, fields_encrypted TEXT NOT NULL,
     message TEXT, last_synced_at INTEGER, updated_at INTEGER NOT NULL,
     provided_field_status TEXT, sent_fields TEXT,
     PRIMARY KEY (seller_id, anchor_domain)
   )`);
  // Older tables may lack columns that were added later by ALTER TABLE.
  const opt = (name: string) => (columns.has(name) ? name : "NULL");
  await client.execute({
    sql: `INSERT INTO seller_kyc_v2
       (seller_id, anchor_domain, account, customer_id, status, required_fields, fields_encrypted,
        message, last_synced_at, updated_at, provided_field_status, sent_fields)
     SELECT seller_id, ?, ${opt("account")}, customer_id, status, required_fields, fields_encrypted,
        message, last_synced_at, updated_at, ${opt("provided_field_status")}, ${opt("sent_fields")}
     FROM seller_kyc`,
    args: [anchorDomain ?? LEGACY_KYC_ANCHOR],
  });
  await client.execute("DROP TABLE seller_kyc");
  await client.execute("ALTER TABLE seller_kyc_v2 RENAME TO seller_kyc");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  /** Home domain of the configured real anchor, used to attribute pre-4.24 `seller_kyc` rows. */
  kycAnchorDomain?: string | null;
  /** Override migrations folder (tests only). */
  migrationsDir?: RunMigrationsOptions["migrationsDir"];
}

/**
 * Prepare the database for use.
 *
 * 1. Runs the pre-Drizzle structural migrations (idempotent, no-op on fresh
 *    databases) to bring any legacy database up to a shape that Drizzle can
 *    manage cleanly.
 * 2. Runs Drizzle migrations with an advisory lock so concurrent instances
 *    cannot race through the journal.
 *
 * Throws and refuses to return on any migration failure — the caller must
 * not serve traffic with an unmigrated database.
 *
 * @param client  The libSQL client.
 * @param dbOrOpts  Either a Drizzle DB instance (preferred), or the options
 *                  object (for callers that don't have a DB at hand — a Drizzle
 *                  DB is created internally in that case).
 * @param opts  Options when `dbOrOpts` is a DB.
 */
export async function bootstrap(
  client: Client,
  dbOrOpts?: DB | BootstrapOptions,
  opts?: BootstrapOptions,
): Promise<void> {
  let db: DB;
  let resolvedOpts: BootstrapOptions;

  // Distinguish a Drizzle DB object from a plain options bag by the presence
  // of `query`, which every drizzle-orm/libsql database exposes and a plain
  // options object never would.
  const isDb = (v: unknown): v is DB =>
    v != null && typeof v === "object" && "query" in (v as object);

  if (isDb(dbOrOpts)) {
    db = dbOrOpts;
    resolvedOpts = opts ?? {};
  } else {
    db = drizzle(client, { schema });
    resolvedOpts = (dbOrOpts as BootstrapOptions | undefined) ?? {};
  }

  // Phase 1: structural legacy migrations (must run before Drizzle sees the tables).
  await migrateLegacyWebhooksTable(client);
  await migrateLegacySellerKycTable(client, resolvedOpts.kycAnchorDomain ?? null);
  await migrateLegacyProcessedTxTable(client);
  await migrateLegacyLinkPaymentsTable(client);
  await migrateLegacyWebhookQueueTable(client);
  await migrateLegacyWebhookDeliveriesTable(client);
  await applyAdditiveMigrations(client);

  // Phase 2: Drizzle-managed migrations (creates tables on fresh databases,
  // applies new migrations on existing ones).
  await runMigrations(db, client, { migrationsDir: resolvedOpts.migrationsDir });

  // Phase 3: data backfills that must run after the schema is fully up to date.
  await backfillSellerLastActiveAt(client);
}

export { schema };
