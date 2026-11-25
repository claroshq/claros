CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`slug` text NOT NULL,
	`kind` text DEFAULT 'webhook' NOT NULL,
	`url` text NOT NULL,
	`secret` text,
	`events` text NOT NULL,
	`config` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_webhook_endpoints_tenant_slug` ON `webhook_endpoints` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE TABLE `webhook_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`event` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`dedup_key` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_outbox_due` ON `webhook_outbox` (`tenant_id`,`next_attempt_at`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `idx_webhook_outbox_tenant_event` ON `webhook_outbox` (`tenant_id`,`event`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_webhook_outbox_dedup` ON `webhook_outbox` (`tenant_id`,`endpoint_id`,`dedup_key`) WHERE dedup_key IS NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `scopes` text;--> statement-breakpoint
ALTER TABLE `flows` ADD `slug` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_flows_tenant_slug` ON `flows` (`tenant_id`,`slug`) WHERE slug IS NOT NULL;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `approved_by` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `rejected_by` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `edited_by` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `edited_at` integer;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `original_subject` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `original_body_html` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `original_body_text` text;--> statement-breakpoint
ALTER TABLE `lifecycle_messages` ADD `forced_action_type` text;