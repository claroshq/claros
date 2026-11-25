CREATE TABLE "tenant_daily_usage" (
	"tenant_id" uuid NOT NULL,
	"day" text NOT NULL,
	"llm_tokens" integer DEFAULT 0 NOT NULL,
	"digest_sent_at" timestamp with time zone,
	CONSTRAINT "tenant_daily_usage_pkey" PRIMARY KEY("tenant_id","day")
);
--> statement-breakpoint
ALTER TABLE "flow_memberships" ADD COLUMN "trigger_properties" jsonb;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "mirror_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_daily_usage" ADD CONSTRAINT "tenant_daily_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;