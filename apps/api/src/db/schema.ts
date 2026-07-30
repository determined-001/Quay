import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sellers = sqliteTable("sellers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  wallet: text("wallet").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const links = sqliteTable("links", {
  id: text("id").primaryKey(),
  reference: text("reference").notNull().unique(),
  sellerId: text("seller_id").notNull(),
  destination: text("destination").notNull(),
  muxedId: text("muxed_id"), // SEP-23 correlation id; null in memo mode (the default)
  title: text("title").notNull(),
  amount: text("amount").notNull(),
  assetCode: text("asset_code").notNull(),
  assetIssuer: text("asset_issuer"), // null = native XLM
  status: text("status").notNull(),
  txHash: text("tx_hash"),
  payer: text("payer"),
  paidAmount: text("paid_amount"),
  offrampJobId: text("offramp_job_id"),
  offrampTargetCurrency: text("offramp_target_currency"),
  offrampStatus: text("offramp_status"),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  sellerId: text("seller_id").notNull(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  linkId: text("link_id").notNull(),
  event: text("event").notNull(),
  statusCode: integer("status_code"),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
});

export const offrampQuotes = sqliteTable("offramp_quotes", {
  quoteId: text("quote_id").primaryKey(),
  linkId: text("link_id").notNull(),
  sellAssetCode: text("sell_asset_code").notNull(),
  sellAssetIssuer: text("sell_asset_issuer"), // null = native XLM
  sellAmount: text("sell_amount").notNull(),
  buyCurrency: text("buy_currency").notNull(),
  price: text("price").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const offrampJobs = sqliteTable("offramp_jobs", {
  jobId: text("job_id").primaryKey(),
  linkId: text("link_id").notNull(),
  anchor: text("anchor").notNull(),
  targetCurrency: text("target_currency").notNull(),
  targetAmount: text("target_amount").notNull(),
  rate: text("rate").notNull(),
  status: text("status").notNull(),
  externalStatus: text("external_status"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Keyed by seller (never by link) — identity is submitted once and reused
// across every link. `fieldsEncrypted` is the only PII column: an AES-256-GCM
// blob of the seller's submitted field values, opaque without KYC_ENCRYPTION_KEY.
export const sellerKyc = sqliteTable("seller_kyc", {
  sellerId: text("seller_id").primaryKey(),
  customerId: text("customer_id"),
  status: text("status").notNull(),
  requiredFields: text("required_fields").notNull(), // JSON KycFieldSpec[] — not PII, just schema metadata
  fieldsEncrypted: text("fields_encrypted").notNull(), // AES-256-GCM blob of Record<string,string>
  message: text("message"),
  lastSyncedAt: integer("last_synced_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const watcherCursors = sqliteTable("watcher_cursors", {
  account: text("account").primaryKey(),
  cursor: text("cursor").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const processedTx = sqliteTable("processed_tx", {
  txHash: text("tx_hash").primaryKey(),
  linkId: text("link_id"),
  createdAt: integer("created_at").notNull(),
});

/**
 * Off-ramp telemetry — one row per cash-out, written passively as it progresses.
 * No product surface consumes this yet; it exists to accumulate the dataset.
 *
 * Columns:
 *   indicative_rate  – the in-memory mock/testanchor rate at quote time (if available)
 *   quoted_rate      – the firm rate returned by quote()
 *   effective_rate   – derived from anchor-reported amount_out at settlement (NOT the quote)
 *   fee_amount       – sell_amount minus the anchor-implied back-calculated sell equivalent
 */
export const offrampTelemetry = sqliteTable("offramp_telemetry", {
  id: text("id").primaryKey(),
  anchorDomain: text("anchor_domain").notNull(),
  corridor: text("corridor").notNull(),   // e.g. "USDC/NGN"
  sellAsset: text("sell_asset").notNull(),
  sellAmount: text("sell_amount").notNull(),
  indicativeRate: text("indicative_rate"),
  quotedRate: text("quoted_rate").notNull(),
  quotedAt: integer("quoted_at").notNull(),
  initiatedAt: integer("initiated_at"),
  settledAt: integer("settled_at"),
  effectiveRate: text("effective_rate"),
  feeAmount: text("fee_amount"),
  status: text("status").notNull(),       // "quoted" | "initiated" | "settled" | "failed"
  failureReason: text("failure_reason"),
});
