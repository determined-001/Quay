-- A database stamped as already migrated (see migrate.ts) may predate seller_kyc
-- entirely; give the rebuild below something to rebuild. A no-op everywhere else.
CREATE TABLE IF NOT EXISTS `seller_kyc` (
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
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_seller_kyc` (
	`seller_id` text NOT NULL,
	`anchor_domain` text NOT NULL,
	`kyc_type` text DEFAULT '' NOT NULL,
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
	PRIMARY KEY(`seller_id`, `anchor_domain`, `kyc_type`)
);
--> statement-breakpoint
INSERT INTO `__new_seller_kyc`("seller_id", "anchor_domain", "kyc_type", "account", "customer_id", "status", "required_fields", "fields_encrypted", "provided_field_status", "sent_fields", "callback_token_hash", "message", "last_synced_at", "updated_at") SELECT "seller_id", "anchor_domain", '', "account", "customer_id", "status", "required_fields", "fields_encrypted", "provided_field_status", "sent_fields", "callback_token_hash", "message", "last_synced_at", "updated_at" FROM `seller_kyc`;--> statement-breakpoint
DROP TABLE `seller_kyc`;--> statement-breakpoint
ALTER TABLE `__new_seller_kyc` RENAME TO `seller_kyc`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `seller_kyc_callback_token_hash_idx` ON `seller_kyc` (`callback_token_hash`);