CREATE TABLE `artifacts` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`text_ordinal` integer NOT NULL,
	`block_index` integer NOT NULL,
	`kind` text NOT NULL,
	`language` text NOT NULL,
	`code` text NOT NULL,
	`derived_title` text NOT NULL,
	`user_title` text,
	`lineage_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "artifacts_slot_nonneg" CHECK("artifacts"."text_ordinal" >= 0 AND "artifacts"."block_index" >= 0),
	CONSTRAINT "artifacts_kind_language" CHECK(("artifacts"."kind" = 'html' AND "artifacts"."language" = 'html') OR ("artifacts"."kind" = 'svg' AND "artifacts"."language" = 'svg') OR ("artifacts"."kind" = 'react' AND "artifacts"."language" IN ('jsx', 'tsx')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_id_unique` ON `artifacts` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_message_slot_idx` ON `artifacts` (`message_id`,`text_ordinal`,`block_index`);--> statement-breakpoint
CREATE INDEX `artifacts_user_updated_idx` ON `artifacts` (`user_id`,`updated_at`,`seq`);--> statement-breakpoint
CREATE INDEX `artifacts_user_lineage_idx` ON `artifacts` (`user_id`,`lineage_id`,`created_at`,`seq`);--> statement-breakpoint
CREATE INDEX `artifacts_chat_idx` ON `artifacts` (`chat_id`);--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `artifacts_backfilled_at` integer;