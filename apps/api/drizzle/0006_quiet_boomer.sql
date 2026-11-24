CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`link_id` text NOT NULL,
	`number` text NOT NULL,
	`client_name` text,
	`client_email` text,
	`total` text NOT NULL,
	`asset_code` text NOT NULL,
	`asset_issuer` text,
	`status` text DEFAULT 'open' NOT NULL,
	`due_at` integer NOT NULL,
	`overdue_notified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `invoices_seller_id_idx` ON `invoices` (`seller_id`);--> statement-breakpoint
CREATE INDEX `invoices_link_id_idx` ON `invoices` (`link_id`);--> statement-breakpoint
CREATE INDEX `invoices_status_due_at_notified_idx` ON `invoices` (`status`,`due_at`,`overdue_notified_at`);