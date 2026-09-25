PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls` text DEFAULT '[]' NOT NULL,
	`tool_call_id` text,
	`relayed_at` text,
	`provider_message_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `execution_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_agent_messages_role" CHECK(role in ('user','agent','tool'))
);
--> statement-breakpoint
INSERT INTO `__new_agent_messages`("id", "session_id", "role", "content", "relayed_at", "provider_message_id", "created_at") SELECT "id", "session_id", "role", "content", "relayed_at", "provider_message_id", "created_at" FROM `agent_messages`;--> statement-breakpoint
DROP TABLE `agent_messages`;--> statement-breakpoint
ALTER TABLE `__new_agent_messages` RENAME TO `agent_messages`;--> statement-breakpoint
-- NOTE: PRAGMA foreign_keys stays OFF from the top of this file so the
-- subsequent `DROP TABLE execution_sessions` / `DROP TABLE tasks` rebuild steps
-- cannot CASCADE-delete referencing rows. Re-enabling is handled by the migrate
-- runner (`src/lib/db/migrate.ts`) which restores `foreign_keys=ON` + runs
-- `PRAGMA foreign_key_check` after the migration transaction commits. Do NOT
-- re-add a `PRAGMA foreign_keys=ON;` here: under drizzle it would either be a
-- no-op (single wrapping transaction) or, in a raw replay, re-enable FKs in the
-- middle of the destructive DROPs and wipe child rows.
CREATE INDEX `idx_agent_messages_session` ON `agent_messages` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_provider` ON `agent_messages` (`provider_message_id`);--> statement-breakpoint
CREATE TABLE `__new_execution_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`house_id` text NOT NULL,
	`agent_id` text,
	`provider_session_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider` text DEFAULT 'opencode' NOT NULL,
	`model_id` text DEFAULT '' NOT NULL,
	`directory` text,
	`last_error` text,
	`cost_total` real DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_execution_sessions_status" CHECK(status in ('pending','running','awaiting_approval','awaiting_input','completed','failed','aborted','interrupted','paused')),
	CONSTRAINT "ck_execution_sessions_provider" CHECK(provider in ('opencode','ollama'))
);
--> statement-breakpoint
INSERT INTO `__new_execution_sessions`("id", "task_id", "house_id", "agent_id", "provider_session_id", "status", "provider", "model_id", "directory", "last_error", "cost_total", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "started_at", "finished_at", "created_at", "updated_at") SELECT "id", "task_id", "house_id", "agent_id", "provider_session_id", "status", "provider", "model_id", "directory", "last_error", "cost_total", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "started_at", "finished_at", "created_at", "updated_at" FROM `execution_sessions`;--> statement-breakpoint
DROP TABLE `execution_sessions`;--> statement-breakpoint
ALTER TABLE `__new_execution_sessions` RENAME TO `execution_sessions`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_execution_sessions_provider` ON `execution_sessions` (`provider_session_id`);--> statement-breakpoint
CREATE INDEX `idx_execution_sessions_task` ON `execution_sessions` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_execution_sessions_house` ON `execution_sessions` (`house_id`);--> statement-breakpoint
CREATE INDEX `idx_execution_sessions_status` ON `execution_sessions` (`status`);--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'general' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`house_id` text,
	`project_id` text,
	`working_directory` text,
	`execution_preferences` text DEFAULT '{}' NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_tasks_title_len" CHECK(length(title) between 1 and 200),
	CONSTRAINT "ck_tasks_priority" CHECK(priority in ('low','medium','high','urgent')),
	CONSTRAINT "ck_tasks_status" CHECK(status in ('queued','running','awaiting_approval','awaiting_input','completed','failed','cancelled','interrupted','paused')),
	CONSTRAINT "ck_tasks_working_dir_abs" CHECK(working_directory is null or working_directory like '/%')
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "title", "description", "type", "priority", "status", "house_id", "project_id", "working_directory", "execution_preferences", "attachments", "created_at", "updated_at") SELECT "id", "title", "description", "type", "priority", "status", "house_id", "project_id", "working_directory", "execution_preferences", "attachments", "created_at", "updated_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE INDEX `idx_tasks_house` ON `tasks` (`house_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_project` ON `tasks` (`project_id`);