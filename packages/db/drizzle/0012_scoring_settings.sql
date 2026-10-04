CREATE TABLE "scoring_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"rules" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "scoring_settings_values" CHECK ("scoring_settings"."id"=1 AND "scoring_settings"."version">0)
);
--> statement-breakpoint
ALTER TABLE "scoring_settings" ADD CONSTRAINT "scoring_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "scoring_settings" ("id", "rules") VALUES (1, '{"codeforces":{"points":[1,2,3,4,5,6,8,10,12,15],"unknownPoints":3},"luogu":{"points":[1,2,3,5,8,10,12,15],"unknownPoints":3},"qoj":{"points":3}}'::jsonb);
