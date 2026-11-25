CREATE TABLE "ops_alerts" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"tenant_id" uuid,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"last_notified_at" timestamp with time zone,
	"notified_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"muted_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"fingerprint" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb
);
--> statement-breakpoint
CREATE INDEX "idx_ops_events_fingerprint_at" ON "ops_events" USING btree ("fingerprint","at");--> statement-breakpoint
CREATE INDEX "idx_ops_events_at" ON "ops_events" USING btree ("at");