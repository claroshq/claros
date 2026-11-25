CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"kind" text DEFAULT 'webhook' NOT NULL,
	"url" text NOT NULL,
	"secret" text,
	"events" jsonb NOT NULL,
	"config" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "webhook_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"dedup_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "rejected_by" text;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "edited_by" text;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "original_subject" text;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "original_body_html" text;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "original_body_text" text;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "forced_action_type" text;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_webhook_endpoints_tenant_slug" ON "webhook_endpoints" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "idx_webhook_outbox_due" ON "webhook_outbox" USING btree ("tenant_id","next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_webhook_outbox_tenant_event" ON "webhook_outbox" USING btree ("tenant_id","event","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_webhook_outbox_dedup" ON "webhook_outbox" USING btree ("tenant_id","endpoint_id","dedup_key") WHERE dedup_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_flows_tenant_slug" ON "flows" USING btree ("tenant_id","slug") WHERE slug IS NOT NULL;