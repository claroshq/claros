CREATE TABLE "instance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "memberships_pkey" PRIMARY KEY("user_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "public_host" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "config_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "instance_role" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memberships_tenant" ON "memberships" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tenants_public_host" ON "tenants" USING btree ("public_host") WHERE public_host IS NOT NULL;--> statement-breakpoint
-- Backfill (multi-product, expand step): every existing user becomes a member
-- of their home product with their current role.
INSERT INTO "memberships" ("user_id", "tenant_id", "role", "created_at")
SELECT "id", "tenant_id", "role", COALESCE("created_at", now()) FROM "users"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Backfill: the active owners of the oldest product become instance admins.
UPDATE "users" SET "instance_role" = 'admin'
WHERE "role" = 'owner'
  AND "deactivated_at" IS NULL
  AND "tenant_id" = (SELECT "id" FROM "tenants" ORDER BY "created_at" ASC NULLS LAST, "id" ASC LIMIT 1);
