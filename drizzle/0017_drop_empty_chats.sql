-- Before slice 16, New chat and the first visit made a chat row before any message. A chat row now exists only
-- with its first prompt, so this removes the chats that never got one. A memory that names such a chat keeps
-- its row with a null source (ON DELETE SET NULL). A second run deletes nothing.
DELETE FROM chats
WHERE NOT EXISTS (
	SELECT 1 FROM messages WHERE messages.chat_id = chats.id
);
