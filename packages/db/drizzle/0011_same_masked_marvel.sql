CREATE TABLE "site_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"header_text" text DEFAULT '' NOT NULL,
	"login_text" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "site_settings_values" CHECK ("site_settings"."id"=1 AND "site_settings"."version">0 AND length("site_settings"."header_text")<=80 AND length("site_settings"."login_text")<=800)
);
--> statement-breakpoint
ALTER TABLE "site_settings" ADD CONSTRAINT "site_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "site_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
