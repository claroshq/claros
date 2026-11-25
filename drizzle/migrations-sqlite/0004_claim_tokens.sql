CREATE TABLE `claim_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_claim_tokens_token_hash` ON `claim_tokens` (`token_hash`);