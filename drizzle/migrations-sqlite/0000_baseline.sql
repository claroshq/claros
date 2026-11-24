CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
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
CREATE UNIQUE INDEX `uq_api_keys_hash_active` ON `api_keys` (`key_hash`) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_api_keys_tenant` ON `api_keys` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `contact_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`field` text NOT NULL,
	`rejected_value` text NOT NULL,
	`event_id` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_contact_conflicts_tenant` ON `contact_conflicts` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_contact_conflicts_contact` ON `contact_conflicts` (`contact_id`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`external_id` text NOT NULL,
	`email` text,
	`name` text,
	`company` text,
	`properties` text,
	`lifecycle_state` text NOT NULL,
	`engagement_depth` text,
	`payment_status` text DEFAULT 'free',
	`first_seen_at` integer,
	`last_seen_at` integer,
	`activated_at` integer,
	`created_at` integer,
	`event_count_bucket_current` integer DEFAULT 0,
	`event_count_bucket_prev` integer DEFAULT 0,
	`last_counter_reset_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_contacts_tenant_external_id` ON `contacts` (`tenant_id`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_contacts_tenant_email` ON `contacts` (`tenant_id`,`email`) WHERE email IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_contacts_tenant_state` ON `contacts` (`tenant_id`,`lifecycle_state`);--> statement-breakpoint
CREATE INDEX `idx_contacts_last_seen` ON `contacts` (`tenant_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_contacts_tenant_created` ON `contacts` (`tenant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`type` text NOT NULL,
	`event_name` text,
	`properties` text,
	`context` text,
	`message_id` text,
	`timestamp` integer NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_events_contact_time` ON `events` (`contact_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_events_tenant_name` ON `events` (`tenant_id`,`event_name`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_events_tenant_time` ON `events` (`tenant_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_events_dedup_lookup` ON `events` (`tenant_id`,`message_id`) WHERE message_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `flow_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`current_step` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`entered_at` integer NOT NULL,
	`completed_at` integer,
	`exited_at` integer,
	`exit_reason` text,
	`condition_error` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_flow_membership_active` ON `flow_memberships` (`contact_id`,`flow_id`) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX `idx_flow_members_contact` ON `flow_memberships` (`contact_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_flow_members_flow` ON `flow_memberships` (`flow_id`,`status`,`current_step`);--> statement-breakpoint
CREATE TABLE `flows` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`priority` integer DEFAULT 0,
	`trigger_type` text NOT NULL,
	`trigger_config` text NOT NULL,
	`steps` text NOT NULL,
	`source` text DEFAULT 'manual',
	`content_mode` text DEFAULT 'ai_drafted',
	`status` text DEFAULT 'draft',
	`approval_mode` text DEFAULT 'require',
	`flow_class` text DEFAULT 'nurture' NOT NULL,
	`reentry_policy` text DEFAULT 'cooldown' NOT NULL,
	`reentry_cooldown_days` integer DEFAULT 30,
	`prompt_source` text,
	`compiled_plan` text,
	`compiled_at` integer,
	`compile_status` text,
	`compile_error` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_invites_token_hash` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_invites_tenant` ON `invites` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `kb_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`content_type` text DEFAULT 'markdown',
	`source` text DEFAULT 'manual',
	`source_url` text,
	`tags` text,
	`embedding` text,
	`embedding_status` text,
	`embedding_error` text,
	`is_active` integer DEFAULT true,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_kb_entries_tenant_created` ON `kb_entries` (`tenant_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `lifecycle_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`flow_step_order` integer,
	`status` text NOT NULL,
	`feedback` text,
	`subject` text,
	`body_html` text,
	`body_text` text,
	`brain_reasoning` text,
	`brain_action_type` text,
	`scheduled_send_at` integer,
	`approved_at` integer,
	`sent_at` integer,
	`retry_count` integer DEFAULT 0,
	`provider_message_id` text,
	`recipient_address` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`membership_id`) REFERENCES `flow_memberships`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_drain` ON `lifecycle_messages` (`tenant_id`,`status`,`scheduled_send_at`) WHERE status IN ('approved', 'sending');--> statement-breakpoint
CREATE INDEX `idx_messages_contact` ON `lifecycle_messages` (`contact_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_contact_sent` ON `lifecycle_messages` (`contact_id`,`sent_at`) WHERE status IN ('sending', 'sent');--> statement-breakpoint
CREATE UNIQUE INDEX `uq_messages_membership_step` ON `lifecycle_messages` (`membership_id`,`flow_step_order`);--> statement-breakpoint
CREATE INDEX `idx_messages_generation` ON `lifecycle_messages` (`tenant_id`,`status`,`created_at`) WHERE status IN ('pending_generation', 'generating');--> statement-breakpoint
CREATE INDEX `idx_messages_provider_id` ON `lifecycle_messages` (`provider_message_id`) WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_messages_tenant_sent` ON `lifecycle_messages` (`tenant_id`,`sent_at`) WHERE sent_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `lifecycle_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`from_state` text NOT NULL,
	`to_state` text NOT NULL,
	`trigger_event_id` text,
	`metadata` text,
	`transitioned_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_transitions_contact` ON `lifecycle_transitions` (`contact_id`,`transitioned_at`);--> statement-breakpoint
CREATE INDEX `idx_transitions_tenant_time` ON `lifecycle_transitions` (`tenant_id`,`transitioned_at`);--> statement-breakpoint
CREATE TABLE `llm_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`provider` text NOT NULL,
	`config` text NOT NULL,
	`is_active` integer DEFAULT true,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `magic_link_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_magic_link_tokens_hash` ON `magic_link_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `message_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`message_id` text NOT NULL,
	`event_type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`provider_event_id` text,
	`metadata` text,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `lifecycle_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_message_events_message` ON `message_events` (`message_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_message_events_tenant_type_day` ON `message_events` (`tenant_id`,`event_type`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_message_events_provider_dedup` ON `message_events` (`tenant_id`,`provider_event_id`) WHERE provider_event_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `retention_grid_snapshots` (
	`tenant_id` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`tenure_bucket` text NOT NULL,
	`recency_bucket` text NOT NULL,
	`contact_count` integer NOT NULL,
	`paying_count` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `snapshot_date`, `tenure_bucket`, `recency_bucket`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scan_checkpoints` (
	`scan_phase` text NOT NULL,
	`tenant_id` text NOT NULL,
	`last_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`discard_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`scan_phase`, `tenant_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`reason` text NOT NULL,
	`source` text,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`subject` text NOT NULL,
	`body_html` text NOT NULL,
	`body_text` text,
	`variables` text,
	`category` text,
	`is_active` integer DEFAULT true,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_templates_tenant_slug` ON `templates` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`plan` text DEFAULT 'free',
	`settings` text,
	`business_model` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `transport_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`provider` text NOT NULL,
	`config` text NOT NULL,
	`is_active` integer DEFAULT true,
	`dkim_verified` integer DEFAULT false,
	`from_email` text NOT NULL,
	`from_name` text,
	`daily_limit` integer,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`role` text DEFAULT 'member' NOT NULL,
	`last_login_at` integer,
	`deactivated_at` integer,
	`pending_email` text,
	`pending_email_token_hash` text,
	`pending_email_expires_at` integer,
	`created_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_tenant_email` ON `users` (`tenant_id`,`email`);