CREATE TABLE "contact_dates" (
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"property" text NOT NULL,
	"value" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "contact_dates_pkey" PRIMARY KEY("tenant_id","contact_id","property")
);
--> statement-breakpoint
ALTER TABLE "flow_memberships" ADD COLUMN "anchor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kb_entries" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "kb_entries" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "kb_entries" ADD COLUMN "data" jsonb;--> statement-breakpoint
ALTER TABLE "kb_entries" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_entries" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "kb_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "imported" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "import_key" text;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "context_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "choose_decision" jsonb;--> statement-breakpoint
ALTER TABLE "lifecycle_messages" ADD COLUMN "opening_line" text;--> statement-breakpoint
ALTER TABLE "contact_dates" ADD CONSTRAINT "contact_dates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_dates" ADD CONSTRAINT "contact_dates_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_contact_dates_scan" ON "contact_dates" USING btree ("tenant_id","property","value");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_flow_membership_anchor" ON "flow_memberships" USING btree ("tenant_id","flow_id","contact_id","anchor_at") WHERE anchor_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_kb_entries_external_key" ON "kb_entries" USING btree ("tenant_id","external_key") WHERE external_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_kb_entries_category" ON "kb_entries" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_import_key" ON "lifecycle_messages" USING btree ("tenant_id","import_key") WHERE import_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_kb_entry" ON "lifecycle_messages" USING btree ("tenant_id","contact_id","kb_entry_id") WHERE kb_entry_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_expires" ON "lifecycle_messages" USING btree ("tenant_id","expires_at") WHERE expires_at IS NOT NULL;