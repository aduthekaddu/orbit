ALTER TABLE `chats` ADD `head_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `parent_id` text;--> statement-breakpoint
CREATE INDEX `messages_chat_parent_idx` ON `messages` (`chat_id`,`parent_id`);--> statement-breakpoint
WITH ordered AS (
  SELECT id, lag(id) OVER (PARTITION BY chat_id ORDER BY position, created_at, id) AS parent
  FROM messages
)
UPDATE messages SET parent_id = (SELECT parent FROM ordered WHERE ordered.id = messages.id);
--> statement-breakpoint
UPDATE chats SET head_id = (
  SELECT id FROM messages WHERE messages.chat_id = chats.id
  ORDER BY position DESC, created_at DESC, id DESC LIMIT 1
);
