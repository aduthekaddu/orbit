CREATE TABLE `memory_runs` (
	`date` text PRIMARY KEY NOT NULL,
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
	`error` text
);
