ALTER TABLE "sync_runs" ADD COLUMN "range_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "range_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "scan_cursor" jsonb;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "scan_checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "cursor_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "stop_reason" text DEFAULT 'more' NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "range_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_run_range" CHECK (("sync_runs"."range_from" IS NULL AND "sync_runs"."range_to" IS NULL) OR ("sync_runs"."range_from" IS NOT NULL AND "sync_runs"."range_to" IS NOT NULL AND "sync_runs"."range_from"<"sync_runs"."range_to" AND "sync_runs"."range_to"-"sync_runs"."range_from"<=interval '366 days'));