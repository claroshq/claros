CREATE TABLE `contact_dates` (
	`tenant_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`property` text NOT NULL,
	`value` integer NOT NULL,
	`updated_at` integer,
	PRIMARY KEY(`tenant_id`, `contact_id`, `property`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_contact_dates_scan` ON `contact_dates` (`tenant_id`,`property`,`value`);--> statement-breakpoint
ALTER TABLE `flow_memberships` ADD `anchor_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_flow_membership_anchor` ON `flow_memberships` (`tenant_id`,`flow_id`,`contact_id`,`anchor_at`) WHERE anchor_at IS NOT NULL;--> statement-breakpoint
ALTER TABLE `kb_entries` ADD `category` text;--> statement-breakpoint
ALTER TABLE `kb_entries` ADD `external_key` text;--> statement-breakpoint
ALTER TABLE `kb_entries` ADD `data` text;--> statement-breakpoint
ALTER TABLE `kb_entries` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `kb_entries` ADD `imported_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_kb_entries_external_key` ON `kb_entries` (`tenant_id`,`external_key`) WHERE external_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_kb_entries_category` ON `kb_entries` (`tenant_id`,`category`);--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `kb_entry_id` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `imported` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `import_key` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `context_snapshot` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `choose_decision` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `opening_line` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_messages_import_key` ON `lifecycle_messages` (`tenant_id`,`import_key`) WHERE import_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_kb_entry` ON `lifecycle_messages` (`tenant_id`,`contact_id`,`kb_entry_id`) WHERE kb_entry_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_expires` ON `lifecycle_messages` (`tenant_id`,`expires_at`) WHERE expires_at IS NOT NULL;