CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`used_at` integer,
	`used_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`used_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `invites_created_by_idx` ON `invites` (`created_by`);
--> statement-breakpoint
CREATE INDEX `invites_expires_at_idx` ON `invites` (`expires_at`);
--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `signup_mode` text DEFAULT 'invite' NOT NULL CONSTRAINT `instance_settings_signup_mode` CHECK (`signup_mode` IN ('invite', 'open'));
