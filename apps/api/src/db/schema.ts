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
  /** Which attempt number this row records (1-based). */
  attempt: integer("attempt").notNull().default(1),
  /** ID of the queue entry this delivery belongs to. Null for legacy rows. */
  queueEntryId: text("queue_entry_id"),
  statusCode: integer("status_code"),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
});

/**
 * Durable delivery queue.  Each row = one pending (or dead-lettered) delivery.
 * The worker claims rows by atomically flipping status from "pending" → "claimed",
 * then delivers, then either resolves → "delivered" or reschedules / dead-letters.
 *
 * status lifecycle:
 *   pending → claimed → delivered
 *                    ↘ pending  (transient failure, next_attempt_at bumped)
 *                    ↘ dead     (exhausted max attempts)
 *   dead   → pending  (manual replay via POST /webhooks/deliveries/:id/replay)
 */
export const webhookQueue = sqliteTable("webhook_queue", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  linkId: text("link_id").notNull(),
  event: text("event").notNull(),
  /** JSON-serialised event payload — the exact body that will be signed & sent. */
  payload: text("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull(),
  /** pending | claimed | delivered | dead */
  status: text("status").notNull().default("pending"),
  lastStatusCode: integer("last_status_code"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
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
