ALTER TABLE `settings` DROP COLUMN `base_url`;--> statement-breakpoint
ALTER TABLE `settings` DROP COLUMN `api_key`;--> statement-breakpoint
ALTER TABLE `settings` DROP COLUMN `model`;--> statement-breakpoint
ALTER TABLE `settings` DROP COLUMN `reasoning_effort`;--> statement-breakpoint
-- In the same transaction as the drops: user_version 1 tells src/lib/db/index.ts that free space may still hold the plain key.
PRAGMA user_version = 1;