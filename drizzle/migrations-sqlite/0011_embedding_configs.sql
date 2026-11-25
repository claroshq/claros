CREATE TABLE `embedding_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`provider` text NOT NULL,
	`config` text NOT NULL,
	`is_active` integer DEFAULT true,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_embedding_configs_tenant_active` ON `embedding_configs` (`tenant_id`,`is_active`);