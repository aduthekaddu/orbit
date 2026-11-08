CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`text_norm` text NOT NULL,
	`source_chat_id` text,
	`source_message_id` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`source_chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_text_norm_idx` ON `memories` (`text_norm`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `memories_fts` USING fts5(text, content='memories', content_rowid='rowid');
--> statement-breakpoint
CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
	INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
--> statement-breakpoint
CREATE TRIGGER memories_fts_au AFTER UPDATE OF text ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
	INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
--> statement-breakpoint
INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
--> statement-breakpoint
CREATE VIRTUAL TABLE `memories_vec` USING vec0(embedding float[768]);