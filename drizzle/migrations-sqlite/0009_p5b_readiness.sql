CREATE TABLE `tenant_daily_usage` (
	`tenant_id` text NOT NULL,
	`day` text NOT NULL,
	`llm_tokens` integer DEFAULT 0 NOT NULL,
	`digest_sent_at` integer,
	PRIMARY KEY(`tenant_id`, `day`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `flow_memberships` ADD `trigger_properties` text;--> statement-breakpoint
ALTER TABLE `topics` ADD `mirror_only` integer DEFAULT false NOT NULL;