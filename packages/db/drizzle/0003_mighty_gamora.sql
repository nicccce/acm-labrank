CREATE TABLE "collection_control" (
	"id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_control_singleton" CHECK ("collection_control"."id"=1)
);
--> statement-breakpoint
CREATE TABLE "platform_account_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"key" text NOT NULL,
	"account_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"kind" text DEFAULT 'person' NOT NULL,
	"external_id" text,
	"handle" text NOT NULL,
	"identity_key" text NOT NULL,
	CONSTRAINT "account_person_only" CHECK ("platform_accounts"."kind"='person')
);
--> statement-breakpoint
CREATE TABLE "platform_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"account_id" uuid,
	"candidate" text,
	"candidate_state" text,
	"candidate_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "binding_candidate_state" CHECK ("platform_bindings"."candidate_state" IS NULL OR "platform_bindings"."candidate_state" IN ('pending','verified','not_found','occupied','unavailable','unsupported'))
);
--> statement-breakpoint
CREATE TABLE "platform_login_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"generation" integer NOT NULL,
	"state" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"encrypted_context" text,
	"image" text,
	"content_type" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_attempt_state" CHECK ("platform_login_attempts"."state" IN ('processing','awaiting_input','succeeded','failed','cancelled','expired'))
);
--> statement-breakpoint
CREATE TABLE "problems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"problem_key" text NOT NULL,
	"title" text NOT NULL,
	"native_difficulty" double precision,
	"source_url" text NOT NULL,
	"difficulty_updated_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_attributions" (
	"submission_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"account_id" uuid,
	"method" text NOT NULL,
	"rule_version" text DEFAULT 'personal-v1' NOT NULL,
	CONSTRAINT "attribution_person_pair" CHECK (("submission_attributions"."user_id" IS NULL)=("submission_attributions"."account_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"external_submission_id" text NOT NULL,
	"problem_id" uuid,
	"submitted_at" timestamp with time zone,
	"verdict" text NOT NULL,
	"native_score" double precision,
	"native_result" text,
	"source_url" text,
	"subject_evidence" jsonb NOT NULL,
	"parser_version" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "submission_verdict" CHECK ("submissions"."verdict" IN ('accepted','rejected','pending','unknown'))
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"cursor" jsonb,
	"checkpoint" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"history_complete" boolean DEFAULT false NOT NULL,
	"coverage" text DEFAULT 'unknown' NOT NULL,
	"last_success_at" timestamp with time zone,
	CONSTRAINT "sync_cursor_mode" CHECK ("sync_cursors"."mode" IN ('backfill','incremental'))
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"binding_version" integer NOT NULL,
	"account_id" uuid,
	"kind" text NOT NULL,
	"mode" text DEFAULT 'backfill' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"batch" integer DEFAULT 0 NOT NULL,
	"job_id" uuid,
	"queue" text NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"records" integer DEFAULT 0 NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "sync_run_kind" CHECK ("sync_runs"."kind" IN ('verify','sync')),
	CONSTRAINT "sync_run_status" CHECK ("sync_runs"."status" IN ('queued','running','completed','paused','failed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "platform_account_aliases" ADD CONSTRAINT "platform_account_aliases_account_id_platform_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_bindings" ADD CONSTRAINT "platform_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_bindings" ADD CONSTRAINT "platform_bindings_account_id_platform_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_login_attempts" ADD CONSTRAINT "platform_login_attempts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_login_attempts" ADD CONSTRAINT "platform_login_attempts_connection_id_platform_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."platform_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_attributions" ADD CONSTRAINT "submission_attributions_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_attributions" ADD CONSTRAINT "submission_attributions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_attributions" ADD CONSTRAINT "submission_attributions_account_id_platform_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_account_id_platform_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_binding_id_platform_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."platform_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_account_id_platform_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_alias_identity" ON "platform_account_aliases" USING btree ("platform","key");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_account_identity" ON "platform_accounts" USING btree ("platform","identity_key");--> statement-breakpoint
CREATE UNIQUE INDEX "binding_user_platform" ON "platform_bindings" USING btree ("user_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "binding_account_owner" ON "platform_bindings" USING btree ("account_id") WHERE "platform_bindings"."account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "login_attempt_expiry" ON "platform_login_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "problem_identity" ON "problems" USING btree ("platform","problem_key");--> statement-breakpoint
CREATE INDEX "attribution_user" ON "submission_attributions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_identity" ON "submissions" USING btree ("platform","external_submission_id");--> statement-breakpoint
CREATE INDEX "submission_ac_time" ON "submissions" USING btree ("problem_id","submitted_at") WHERE "submissions"."verdict"='accepted';--> statement-breakpoint
CREATE UNIQUE INDEX "sync_cursor_account_mode" ON "sync_cursors" USING btree ("account_id","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "active_sync_target_kind" ON "sync_runs" USING btree ("binding_id","kind","mode") WHERE "sync_runs"."status" IN ('queued','running');