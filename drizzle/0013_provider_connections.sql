CREATE TABLE `hidden_models` (
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`model_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `connection_id`, `model_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `provider_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pending_connection` (
	`id` integer PRIMARY KEY NOT NULL,
	`base_url` text NOT NULL,
	`api_key_ciphertext` text NOT NULL,
	`model` text,
	`effort` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "pending_connection_single_row" CHECK("pending_connection"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `provider_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`base_url` text,
	`api_key_ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "provider_connections_base_url" CHECK(("provider_connections"."kind" = 'openai-compatible' AND "provider_connections"."base_url" IS NOT NULL) OR ("provider_connections"."kind" = 'anthropic' AND "provider_connections"."base_url" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `provider_connections_user_id_idx` ON `provider_connections` (`user_id`);--> statement-breakpoint
ALTER TABLE `chats` ADD `connection_id` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `model` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `reasoning_effort` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `connection_id` text REFERENCES provider_connections(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `model` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `reasoning_effort` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `effort_outcome` text;--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `default_connection_id` text REFERENCES provider_connections(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `default_model` text;--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `default_effort` text;