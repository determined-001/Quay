CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`number` text,
	`link_id` text,
	`client_name` text NOT NULL,
	`client_email_encrypted` text,
	`client_address_encrypted` text,
	`notes` text,
	`asset_code` text NOT NULL,
	`line_items` text NOT NULL,
	`total` text NOT NULL,
	`issued_at` integer,
	`due_at` integer NOT NULL,
	`state` text NOT NULL,
	`overdue_notified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_seller_number_unique` ON `invoices` (`seller_id`,`number`);--> statement-breakpoint
CREATE INDEX `invoices_seller_created_idx` ON `invoices` (`seller_id`,`created_at`);