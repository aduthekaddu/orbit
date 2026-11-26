CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`theme` text DEFAULT 'dark' NOT NULL,
	`text_size` text DEFAULT 'md' NOT NULL,
	`reply_font` text DEFAULT 'sans' NOT NULL,
	`chat_width` text DEFAULT 'normal' NOT NULL,
	`accent` text DEFAULT 'sun' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
