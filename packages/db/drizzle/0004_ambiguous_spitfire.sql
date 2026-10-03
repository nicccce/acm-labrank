ALTER TABLE "platform_connections" ADD COLUMN "reading_verified_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_account_id_platform" ON "platform_accounts" USING btree ("id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_account_external" ON "platform_accounts" USING btree ("platform","external_id") WHERE "platform_accounts"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "problem_id_platform" ON "problems" USING btree ("id","platform");--> statement-breakpoint
ALTER TABLE "platform_account_aliases" ADD CONSTRAINT "platform_account_aliases_account_id_platform_platform_accounts_id_platform_fk" FOREIGN KEY ("account_id","platform") REFERENCES "public"."platform_accounts"("id","platform") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_bindings" ADD CONSTRAINT "platform_bindings_account_id_platform_platform_accounts_id_platform_fk" FOREIGN KEY ("account_id","platform") REFERENCES "public"."platform_accounts"("id","platform") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_problem_id_platform_problems_id_platform_fk" FOREIGN KEY ("problem_id","platform") REFERENCES "public"."problems"("id","platform") ON DELETE no action ON UPDATE no action;
