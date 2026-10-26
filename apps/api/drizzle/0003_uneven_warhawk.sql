CREATE TABLE `prefill_consents` (
	`seller_id` text NOT NULL,
	`anchor_domain` text NOT NULL,
	`fields` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`seller_id`, `anchor_domain`)
);
