CREATE TABLE "connector_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"encrypted_session" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_request_limits" (
	"platform" text PRIMARY KEY NOT NULL,
	"next_request_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_until" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "platform_request_lease_pair" CHECK (("platform_request_limits"."lease_token" IS NULL) = ("platform_request_limits"."lease_expires_at" IS NULL))
);
