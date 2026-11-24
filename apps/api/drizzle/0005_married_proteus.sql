CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`payment_tx_hash` text NOT NULL,
	`payment_operation_id` text NOT NULL,
	`destination` text NOT NULL,
	`destination_muxed_id` text,
	`memo` text,
	`memo_type` text,
	`amount` text NOT NULL,
	`asset_code` text NOT NULL,
	`asset_issuer` text,
	`status` text NOT NULL,
	`tx_hash` text,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `refunds_link_id_idx` ON `refunds` (`link_id`);--> statement-breakpoint
CREATE INDEX `refunds_payment_idx` ON `refunds` (`payment_tx_hash`,`payment_operation_id`);--> statement-breakpoint
CREATE INDEX `refunds_status_idx` ON `refunds` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_tx_hash_unique` ON `refunds` (`tx_hash`);