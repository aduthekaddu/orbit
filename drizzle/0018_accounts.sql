ALTER TABLE user ADD role text DEFAULT 'member' NOT NULL;
--> statement-breakpoint
UPDATE user SET role = 'admin' WHERE id = (SELECT id FROM user ORDER BY created_at, id LIMIT 1);
--> statement-breakpoint
CREATE UNIQUE INDEX user_one_admin_idx ON user(role) WHERE role = 'admin';
--> statement-breakpoint
ALTER TABLE user_preferences ADD memory text DEFAULT 'on' NOT NULL;
--> statement-breakpoint
CREATE TABLE `instance_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`hosting_mode` text DEFAULT 'personal' NOT NULL,
	`searxng_url` text DEFAULT '' NOT NULL,
	`tavily_key_ciphertext` text DEFAULT '' NOT NULL,
	`sandbox` text DEFAULT 'on' NOT NULL,
	`dream_hour` integer DEFAULT 3 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "instance_settings_single_row" CHECK("instance_settings"."id" = 1),
	CONSTRAINT "instance_settings_dream_hour" CHECK("instance_settings"."dream_hour" >= 0 AND "instance_settings"."dream_hour" <= 23)
);
--> statement-breakpoint
CREATE TABLE `user_github` (
	`user_id` text PRIMARY KEY NOT NULL,
	`token_ciphertext` text DEFAULT '' NOT NULL,
	`mcp_url` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO instance_settings (id, searxng_url, tavily_key_ciphertext, dream_hour, updated_at)
SELECT id, searxng_url, orbit_encrypt_field(tavily_api_key, 'instance_settings.tavily_api_key'), orbit_env_dream_hour(), updated_at
FROM settings WHERE id = 1;
--> statement-breakpoint
INSERT INTO user_github (user_id, token_ciphertext, mcp_url, updated_at)
SELECT user.id, orbit_encrypt_field(settings.github_token, 'user_github.token'), settings.github_mcp_url, settings.updated_at
FROM settings JOIN user ON user.role = 'admin'
WHERE settings.id = 1 AND (settings.github_token <> '' OR settings.github_mcp_url <> '');
--> statement-breakpoint
DROP TABLE settings;
--> statement-breakpoint
PRAGMA user_version = 1;
--> statement-breakpoint
CREATE TABLE __new_memories (
  seq integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  id text NOT NULL,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind text NOT NULL,
  text text NOT NULL,
  text_norm text NOT NULL,
  source text DEFAULT 'unknown' NOT NULL,
  source_chat_id text REFERENCES chats(id) ON DELETE SET NULL,
  source_message_id text REFERENCES messages(id) ON DELETE SET NULL,
  created_at integer NOT NULL,
  last_used_at integer
);
--> statement-breakpoint
INSERT INTO __new_memories (seq, id, user_id, kind, text, text_norm, source, source_chat_id, source_message_id, created_at, last_used_at)
SELECT memories.seq, memories.id, user.id, memories.kind, memories.text, memories.text_norm, memories.source,
       memories.source_chat_id, memories.source_message_id, memories.created_at, memories.last_used_at
FROM memories JOIN user ON user.role = 'admin';
--> statement-breakpoint
DROP TABLE memories;
--> statement-breakpoint
ALTER TABLE __new_memories RENAME TO memories;
--> statement-breakpoint
CREATE UNIQUE INDEX memories_id_unique ON memories(id);
--> statement-breakpoint
CREATE INDEX memories_user_id_idx ON memories(user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX memories_user_text_norm_idx ON memories(user_id, text_norm);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `__new_memory_runs` (
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`state` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`owner` text,
	`lease_until` integer,
	`chat_ids` text NOT NULL,
	`done_chat_ids` text NOT NULL,
	`retry_chat_ids` text NOT NULL,
	`added` integer NOT NULL,
	`merged` integer NOT NULL,
	`error` text,
	PRIMARY KEY(`user_id`, `date`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO __new_memory_runs (user_id, date, state, started_at, finished_at, owner, lease_until, chat_ids, done_chat_ids, retry_chat_ids, added, merged, error)
SELECT user.id, date, state, started_at, finished_at, owner, lease_until, chat_ids, done_chat_ids, retry_chat_ids, added, merged, error
FROM memory_runs JOIN user ON user.role = 'admin';
--> statement-breakpoint
DROP TABLE memory_runs;
--> statement-breakpoint
ALTER TABLE __new_memory_runs RENAME TO memory_runs;
