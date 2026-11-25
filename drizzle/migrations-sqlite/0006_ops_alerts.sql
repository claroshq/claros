CREATE TABLE `ops_alerts` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`tenant_id` text,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`last_notified_at` integer,
	`notified_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`muted_until` integer
);
--> statement-breakpoint
CREATE TABLE `ops_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`tenant_id` text,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`fingerprint` text NOT NULL,
	`message` text NOT NULL,
	`context` text
);
--> statement-breakpoint
CREATE INDEX `idx_ops_events_fingerprint_at` ON `ops_events` (`fingerprint`,`at`);--> statement-breakpoint
CREATE INDEX `idx_ops_events_at` ON `ops_events` (`at`);