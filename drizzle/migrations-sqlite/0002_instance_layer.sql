CREATE TABLE `instance_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `memberships` (
	`user_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer,
	PRIMARY KEY(`user_id`, `tenant_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_memberships_tenant` ON `memberships` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `__new_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`label` text,
	`kind` text DEFAULT 'secret' NOT NULL,
	`allowed_origins` text,
	`last_used_at` integer,
	`created_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_api_keys`("id", "tenant_id", "key_hash", "prefix", "label", "kind", "allowed_origins", "last_used_at", "created_at", "revoked_at") SELECT "id", "tenant_id", "key_hash", "prefix", "label", "kind", "allowed_origins", "last_used_at", "created_at", "revoked_at" FROM `api_keys`;--> statement-breakpoint
DROP TABLE `api_keys`;--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_api_keys_hash_active` ON `api_keys` (`key_hash`) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_api_keys_tenant` ON `api_keys` (`tenant_id`);--> statement-breakpoint
ALTER TABLE `tenants` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `tenants` ADD `public_host` text;--> statement-breakpoint
ALTER TABLE `tenants` ADD `locale` text;--> statement-breakpoint
ALTER TABLE `tenants` ADD `config_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tenants_public_host` ON `tenants` (`public_host`) WHERE public_host IS NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `instance_role` text;--> statement-breakpoint
-- Backfill (multi-product, expand step): every existing user becomes a member
-- of their home product with their current role.
INSERT OR IGNORE INTO `memberships` (`user_id`, `tenant_id`, `role`, `created_at`)
SELECT `id`, `tenant_id`, `role`, COALESCE(`created_at`, CAST(unixepoch('subsec') * 1000 AS INTEGER)) FROM `users`;--> statement-breakpoint
-- Backfill: the active owners of the oldest product become instance admins.
UPDATE `users` SET `instance_role` = 'admin'
WHERE `role` = 'owner'
  AND `deactivated_at` IS NULL
  AND `tenant_id` = (SELECT `id` FROM `tenants` ORDER BY `created_at` IS NULL, `created_at` ASC, `id` ASC LIMIT 1);
