CREATE TABLE `anchors` (
	`id` text PRIMARY KEY NOT NULL,
	`home_domain` text NOT NULL,
	`base_url` text NOT NULL,
	`display_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`protocol` text DEFAULT 'auto' NOT NULL,
	`withdraw_type` text,
	`corridors` text DEFAULT '[]' NOT NULL,
	`rate_source` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anchors_home_domain_unique` ON `anchors` (`home_domain`);