CREATE TABLE `tool_status` (
	`user_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`last_ok_at` integer,
	`last_failed_at` integer,
	`last_error` text,
	PRIMARY KEY(`user_id`, `tool_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `chats` ADD `disabled_tools` text DEFAULT '[]' NOT NULL;