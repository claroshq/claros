CREATE TABLE `email_layouts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`width` text NOT NULL,
	`source` text NOT NULL,
	`based_on` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_email_layouts_tenant_updated` ON `email_layouts` (`tenant_id`,`updated_at`);