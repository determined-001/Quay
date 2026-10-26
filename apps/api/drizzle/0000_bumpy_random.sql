CREATE TABLE `anchor_sessions` (
	`seller_id` text NOT NULL,
	`anchor_domain` text NOT NULL,
	`account` text NOT NULL,
	`token_encrypted` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`seller_id`, `anchor_domain`)
);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`scopes` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text NOT NULL,
	`seller_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`key`, `seller_id`)
);
--> statement-breakpoint
CREATE TABLE `kyc_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`anchor_domain` text NOT NULL,
	`fields` text NOT NULL,
	`granted_at` integer NOT NULL,
	`revoked_at` integer,
	`granted_via` text NOT NULL,
	`notice_version` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kyc_consents_seller_anchor_unique` ON `kyc_consents` (`seller_id`,`anchor_domain`);--> statement-breakpoint
CREATE TABLE `kyc_disclosure_fields` (
	`seller_id` text NOT NULL,
	`anchor_domain` text NOT NULL,
	`field_name` text NOT NULL,
	`sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kyc_disclosure_field_unique` ON `kyc_disclosure_fields` (`seller_id`,`anchor_domain`,`field_name`);--> statement-breakpoint
CREATE TABLE `link_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`tx_hash` text NOT NULL,
	`operation_id` text,
	`payer` text NOT NULL,
	`amount` text NOT NULL,
	`asset_code` text NOT NULL,
	`asset_issuer` text,
	`ledger` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `link_payments_link_id_idx` ON `link_payments` (`link_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `link_payments_tx_hash_operation_id_unique` ON `link_payments` (`tx_hash`,`operation_id`);--> statement-breakpoint
CREATE TABLE `links` (
	`id` text PRIMARY KEY NOT NULL,
	`reference` text NOT NULL,
	`seller_id` text NOT NULL,
	`destination` text NOT NULL,
	`muxed_id` text,
	`title` text NOT NULL,
	`amount` text NOT NULL,
	`asset_code` text NOT NULL,
	`asset_issuer` text,
	`status` text NOT NULL,
	`tx_hash` text,
	`payer` text,
	`paid_amount` text,
	`overpaid_amount` text,
	`offramp_job_id` text,
	`offramp_target_currency` text,
	`offramp_status` text,
	`offramp_indicative_rate` text,
	`offramp_rate` text,
	`offramp_rate_delta` text,
	`offramp_fee_amount` text,
	`offramp_fee_currency` text,
	`offramp_fee_source` text,
	`offramp_net_target_amount` text,
	`expires_at` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `links_reference_unique` ON `links` (`reference`);--> statement-breakpoint
CREATE TABLE `offramp_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`anchor` text NOT NULL,
	`seller_id` text,
	`account` text,
	`target_currency` text NOT NULL,
	`target_amount` text NOT NULL,
	`rate` text NOT NULL,
	`status` text NOT NULL,
	`external_status` text,
	`last_error` text,
	`sell_asset_code` text,
	`sell_asset_issuer` text,
	`sell_amount` text,
	`transfer_json` text,
	`last_poll_error` text,
	`last_poll_error_at` integer,
	`last_poll_reason` text,
	`transfer_notified_at` integer,
	`seller_tx_hash` text,
	`amount_in` text,
	`amount_fee` text,
	`stellar_transaction_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `offramp_quotes` (
	`quote_id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`sell_asset_code` text NOT NULL,
	`sell_asset_issuer` text,
	`sell_amount` text NOT NULL,
	`buy_currency` text NOT NULL,
	`price` text NOT NULL,
	`withdraw_type` text,
	`quoted_rate` text,
	`quoted_target_amount` text,
	`quoted_fee_amount` text,
	`quoted_fee_source` text,
	`quoted_net_target_amount` text,
	`quoted_kind` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `offramp_telemetry` (
	`id` text PRIMARY KEY NOT NULL,
	`anchor_domain` text NOT NULL,
	`corridor` text NOT NULL,
	`sell_asset` text NOT NULL,
	`sell_amount` text NOT NULL,
	`indicative_rate` text,
	`quoted_rate` text NOT NULL,
	`quoted_at` integer NOT NULL,
	`initiated_at` integer,
	`settled_at` integer,
	`effective_rate` text,
	`fee_amount` text,
	`status` text NOT NULL,
	`failure_reason` text
);
--> statement-breakpoint
CREATE TABLE `processed_tx` (
	`tx_hash` text NOT NULL,
	`operation_id` text,
	`link_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tx_hash`, `operation_id`)
);
--> statement-breakpoint
CREATE INDEX `processed_tx_tx_hash_idx` ON `processed_tx` (`tx_hash`);--> statement-breakpoint
CREATE TABLE `revoked_tokens` (
	`jti` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `seller_kyc` (
	`seller_id` text NOT NULL,
	`anchor_domain` text NOT NULL,
	`account` text,
	`customer_id` text,
	`status` text NOT NULL,
	`required_fields` text NOT NULL,
	`fields_encrypted` text NOT NULL,
	`provided_field_status` text,
	`sent_fields` text,
	`callback_token_hash` text,
	`message` text,
	`last_synced_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`seller_id`, `anchor_domain`)
);
--> statement-breakpoint
CREATE INDEX `seller_kyc_callback_token_hash_idx` ON `seller_kyc` (`callback_token_hash`);--> statement-breakpoint
CREATE TABLE `seller_profile` (
	`seller_id` text NOT NULL,
	`field` text NOT NULL,
	`value_encrypted` text NOT NULL,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`seller_id`, `field`)
);
--> statement-breakpoint
CREATE TABLE `sellers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`wallet` text NOT NULL,
	`profile_kind` text DEFAULT 'individual' NOT NULL,
	`payout_fields_json` text,
	`last_active_at` integer,
	`payout_fields_encrypted` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sellers_wallet_unique` ON `sellers` (`wallet`);--> statement-breakpoint
CREATE TABLE `watcher_cursors` (
	`account` text PRIMARY KEY NOT NULL,
	`cursor` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`link_id` text,
	`event` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`queue_entry_id` text,
	`status_code` integer,
	`ok` integer NOT NULL,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_id_created_at_idx` ON `webhook_deliveries` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `webhook_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`link_id` text,
	`event` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_status_code` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_queue_due` ON `webhook_queue` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`url` text NOT NULL,
	`secret_encrypted` text NOT NULL,
	`secret_last4` text NOT NULL,
	`previous_secret_encrypted` text,
	`previous_secret_last4` text,
	`previous_secret_expires_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL
);
