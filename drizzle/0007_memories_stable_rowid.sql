PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memories` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
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
INSERT INTO `__new_memories`("seq", "id", "kind", "text", "text_norm", "source_chat_id", "source_message_id", "created_at", "last_used_at") SELECT rowid, "id", "kind", "text", "text_norm", "source_chat_id", "source_message_id", "created_at", "last_used_at" FROM `memories`;--> statement-breakpoint
DROP TABLE `memories`;--> statement-breakpoint
ALTER TABLE `__new_memories` RENAME TO `memories`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `memories_id_unique` ON `memories` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `memories_text_norm_idx` ON `memories` (`text_norm`);--> statement-breakpoint
CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
	INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;--> statement-breakpoint
CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;--> statement-breakpoint
CREATE TRIGGER memories_fts_au AFTER UPDATE OF text ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
	INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;--> statement-breakpoint
INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');