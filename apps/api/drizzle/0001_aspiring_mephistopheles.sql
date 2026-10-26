CREATE TABLE `pii_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`seller_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`fields` text,
	`request_id` text
);
--> statement-breakpoint
CREATE INDEX `pii_audit_seller_at_idx` ON `pii_audit` (`seller_id`,`at`);--> statement-breakpoint
CREATE INDEX `pii_audit_at_idx` ON `pii_audit` (`at`);