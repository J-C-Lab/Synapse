ALTER TABLE "reports" ALTER COLUMN "reporter_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "kind" text DEFAULT 'user' NOT NULL;