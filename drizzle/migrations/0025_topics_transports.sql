CREATE TABLE "contact_topics" (
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	"source" text,
	CONSTRAINT "contact_topics_pkey" PRIMARY KEY("contact_id","topic_id")
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"default_subscribed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "topic_id" uuid;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "topic_id" uuid;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "transport_id" uuid;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "transport_configs" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "transport_configs" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "transport_configs" ADD COLUMN "reply_to" text;--> statement-breakpoint
ALTER TABLE "contact_topics" ADD CONSTRAINT "contact_topics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_topics" ADD CONSTRAINT "contact_topics_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_topics" ADD CONSTRAINT "contact_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_contact_topics_tenant_topic" ON "contact_topics" USING btree ("tenant_id","topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_topics_tenant_slug" ON "topics" USING btree ("tenant_id","slug");--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Existing transports keep their provider as their kind.
UPDATE "transport_configs" SET "kind" = "provider" WHERE "kind" IS NULL;
