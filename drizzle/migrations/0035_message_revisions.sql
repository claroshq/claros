ALTER TABLE "lifecycle_messages" ADD COLUMN "revision_request" text;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "revisions" jsonb;