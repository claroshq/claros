CREATE TABLE `contact_topics` (
	`tenant_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`topic_id` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer,
	`source` text,
	PRIMARY KEY(`contact_id`, `topic_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_contact_topics_tenant_topic` ON `contact_topics` (`tenant_id`,`topic_id`);--> statement-breakpoint
CREATE TABLE `topics` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`description` text,
	`default_subscribed` integer DEFAULT true NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_topics_tenant_slug` ON `topics` (`tenant_id`,`slug`);--> statement-breakpoint
ALTER TABLE `flows` ADD `topic_id` text REFERENCES topics(id);--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `topic_id` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `transport_id` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `status_reason` text;--> statement-breakpoint
ALTER TABLE `transport_configs` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `transport_configs` ADD `name` text;--> statement-breakpoint
ALTER TABLE `transport_configs` ADD `reply_to` text;--> statement-breakpoint
-- Existing transports keep their provider as their kind.
UPDATE `transport_configs` SET `kind` = `provider` WHERE `kind` IS NULL;
