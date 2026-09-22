CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `execution_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_agent_messages_role" CHECK(role in ('user','agent'))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_messages_session` ON `agent_messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text,
	`house_id` text,
	`provider_request_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`title` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`response` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`responded_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `execution_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_approvals_kind" CHECK(kind in ('permission','question')),
	CONSTRAINT "ck_approvals_status" CHECK(status in ('pending','approved','rejected','replied','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_approvals_provider` ON `approval_requests` (`provider_request_id`);--> statement-breakpoint
CREATE INDEX `idx_approvals_session` ON `approval_requests` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_approvals_status` ON `approval_requests` (`status`);--> statement-breakpoint
CREATE INDEX `idx_approvals_house` ON `approval_requests` (`house_id`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text,
	`kind` text DEFAULT 'other' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `execution_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_artifacts_kind" CHECK(kind in ('diff','file_list','result','other'))
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_session` ON `artifacts` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_task` ON `artifacts` (`task_id`);--> statement-breakpoint
CREATE TABLE `execution_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text,
	`task_id` text,
	`house_id` text,
	`raw_type` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'unknown' NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `execution_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_execution_events_type" CHECK(type in ('task_started','session_started','message','tool_call','tool_result','approval_requested','approval_resolved','task_completed','task_failed','error','usage','session_aborted','unknown'))
);
--> statement-breakpoint
CREATE INDEX `idx_execution_events_session` ON `execution_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_execution_events_task` ON `execution_events` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_execution_events_type` ON `execution_events` (`type`);--> statement-breakpoint
CREATE TABLE `execution_sessions` (
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
	CONSTRAINT "ck_execution_sessions_status" CHECK(status in ('pending','running','awaiting_approval','awaiting_input','completed','failed','aborted','interrupted')),
	CONSTRAINT "ck_execution_sessions_provider" CHECK(provider in ('opencode','ollama'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_execution_sessions_provider` ON `execution_sessions` (`provider_session_id`);--> statement-breakpoint
CREATE INDEX `idx_execution_sessions_task` ON `execution_sessions` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_execution_sessions_house` ON `execution_sessions` (`house_id`);--> statement-breakpoint
CREATE INDEX `idx_execution_sessions_status` ON `execution_sessions` (`status`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`house_id` text,
	`task_id` text,
	`approval_request_id` text,
	`read` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_notifications_type" CHECK(type in ('approval','completion','failure','system'))
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_read` ON `notifications` (`read`);--> statement-breakpoint
CREATE INDEX `idx_notifications_house` ON `notifications` (`house_id`);--> statement-breakpoint
CREATE INDEX `idx_notifications_created` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text,
	`house_id` text,
	`model_id` text DEFAULT '' NOT NULL,
	`provider` text DEFAULT 'opencode' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	`estimated` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `execution_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_usage_records_session` ON `usage_records` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_usage_records_house` ON `usage_records` (`house_id`);--> statement-breakpoint
CREATE INDEX `idx_usage_records_task` ON `usage_records` (`task_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "ck_tasks_status" CHECK(status in ('queued','running','awaiting_approval','awaiting_input','completed','failed','cancelled','interrupted')),
	CONSTRAINT "ck_tasks_working_dir_abs" CHECK(working_directory is null or working_directory like '/%')
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "title", "description", "type", "priority", "status", "house_id", "project_id", "working_directory", "execution_preferences", "attachments", "created_at", "updated_at") SELECT "id", "title", "description", "type", "priority", "status", "house_id", "project_id", "working_directory", "execution_preferences", "attachments", "created_at", "updated_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_tasks_house` ON `tasks` (`house_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_project` ON `tasks` (`project_id`);