CREATE TABLE "collection_platform_state" (
	"platform" text PRIMARY KEY NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "collection_platform_values" CHECK ("collection_platform_state"."platform" IN ('codeforces','luogu','qoj') AND "collection_platform_state"."generation">0)
);
--> statement-breakpoint
CREATE TABLE "collection_reset_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"platforms" text[] DEFAULT '{"codeforces"}' NOT NULL,
	"auto_sync_enabled" boolean DEFAULT false NOT NULL,
	"sync_interval_minutes" integer DEFAULT 360 NOT NULL,
	"score_range" jsonb DEFAULT '{"kind":"rolling","days":30}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "collection_settings_values" CHECK ("collection_settings"."id"=1 AND "collection_settings"."version">0 AND "collection_settings"."sync_interval_minutes" BETWEEN 1 AND 10080 AND "collection_settings"."platforms"<@ARRAY['codeforces','luogu','qoj']::text[])
);
--> statement-breakpoint
ALTER TABLE "platform_bindings" ADD COLUMN "next_sync_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "platform_bindings" ADD COLUMN "sync_blocked" text;--> statement-breakpoint
ALTER TABLE "platform_bindings" ADD COLUMN "sync_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "collection_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "source" text DEFAULT 'binding' NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "requested_by" uuid;--> statement-breakpoint
ALTER TABLE "collection_reset_requests" ADD CONSTRAINT "collection_reset_requests_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_settings" ADD CONSTRAINT "collection_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;