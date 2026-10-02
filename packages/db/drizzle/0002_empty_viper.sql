CREATE TABLE "collection_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"state" text DEFAULT 'unknown' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"cookie_revision" integer DEFAULT 0 NOT NULL,
	"collector" text,
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_token" text,
	"task_expires_at" timestamp with time zone,
	CONSTRAINT "platform_connection_state" CHECK ("platform_connections"."platform" IN ('luogu','qoj') AND "platform_connections"."state" IN ('unknown','ready','auth_required','human_input_required') AND "platform_connections"."generation" >= 0 AND ("platform_connections"."task_token" IS NULL) = ("platform_connections"."task_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "platform_read_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"connection_id" text,
	"request_key" text NOT NULL,
	"input" jsonb NOT NULL,
	"job_id" uuid,
	"queue" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"continuation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"recovery_state" text DEFAULT 'none' NOT NULL,
	"connection_generation" integer,
	"recovery_generation" integer,
	"retry_of" uuid,
	"resolved_by" uuid,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "platform_run_values" CHECK ("platform_read_runs"."platform" IN ('codeforces','luogu','qoj') AND "platform_read_runs"."status" IN ('queued','running','completed','auth_required','human_input_required','restricted','parse_changed','timeout','cancelled','failed') AND "platform_read_runs"."recovery_state" IN ('none','waiting','requeued','resolved'))
);
--> statement-breakpoint
CREATE TABLE "platform_request_policies" (
	"platform" text PRIMARY KEY NOT NULL,
	"min_interval_ms" integer NOT NULL,
	"max_interval_ms" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "platform_policy_intervals" CHECK ("platform_request_policies"."platform" IN ('codeforces','luogu','qoj') AND "platform_request_policies"."min_interval_ms" >= CASE WHEN "platform_request_policies"."platform" = 'codeforces' THEN 2000 ELSE 1000 END AND "platform_request_policies"."max_interval_ms" >= "platform_request_policies"."min_interval_ms" AND "platform_request_policies"."max_interval_ms" <= 60000 AND "platform_request_policies"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "platform_request_limits" ADD COLUMN "lease_interval_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "collection_audit_logs" ADD CONSTRAINT "collection_audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_read_runs" ADD CONSTRAINT "platform_read_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_request_policies" ADD CONSTRAINT "platform_request_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_runs_history_idx" ON "platform_read_runs" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "platform_runs_recovery_idx" ON "platform_read_runs" USING btree ("connection_id","recovery_state");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_runs_active_request_idx" ON "platform_read_runs" USING btree ("request_key") WHERE "platform_read_runs"."status" IN ('queued','running');