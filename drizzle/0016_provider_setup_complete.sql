ALTER TABLE `user_preferences` ADD `provider_setup_complete` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- An existing connection or a saved default effort (retained on delete) records completed setup.
INSERT INTO user_preferences (user_id, provider_setup_complete, updated_at)
SELECT user_id, 1, max(created_at) FROM provider_connections GROUP BY user_id
ON CONFLICT (user_id) DO UPDATE SET provider_setup_complete = 1;
--> statement-breakpoint
UPDATE user_preferences SET provider_setup_complete = 1 WHERE default_effort IS NOT NULL;
--> statement-breakpoint
DELETE FROM pending_connection WHERE EXISTS (SELECT 1 FROM user_preferences WHERE provider_setup_complete = 1);
