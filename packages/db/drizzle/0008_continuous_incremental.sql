ALTER TABLE "sync_cursors" ADD COLUMN "initialized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "scope" text DEFAULT 'range' NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "initial_from" timestamp with time zone;--> statement-breakpoint
UPDATE sync_runs SET scope='initial',initial_from=(date_trunc('day',created_at AT TIME ZONE 'Asia/Shanghai')-interval '29 days') AT TIME ZONE 'Asia/Shanghai',scan_cursor=NULL,scan_checkpoint=NULL,cursor_version=cursor_version+1 WHERE kind='sync' AND range_from IS NULL;
--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_run_scope" CHECK ("sync_runs"."scope" IN ('initial','incremental','range'));--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_initial_from" CHECK (("sync_runs"."scope"='initial')=("sync_runs"."initial_from" IS NOT NULL));