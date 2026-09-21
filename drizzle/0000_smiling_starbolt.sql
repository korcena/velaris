CREATE TABLE `agent_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`system_prompt` text NOT NULL,
	`execution_provider` text NOT NULL,
	`ai_provider` text DEFAULT 'ollama-cloud' NOT NULL,
	`model_id` text DEFAULT '' NOT NULL,
	`workspace_allowlist` text DEFAULT '[]' NOT NULL,
	`tools` text DEFAULT '[]' NOT NULL,
	`permissions` text DEFAULT '{}' NOT NULL,
	`approval_policy` text DEFAULT 'always' NOT NULL,
	`concurrency` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_config_execution_provider" CHECK(execution_provider in ('opencode','ollama')),
	CONSTRAINT "ck_config_approval_policy" CHECK(approval_policy in ('never','always','risky_only')),
	CONSTRAINT "ck_config_concurrency" CHECK(concurrency >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_configurations_agent` ON `agent_configurations` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_configurations_agent_idx` ON `agent_configurations` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`house_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`house_id`) REFERENCES `houses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agents_house` ON `agents` (`house_id`);--> statement-breakpoint
CREATE TABLE `engine_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `houses` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'agent' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "ck_houses_name_len" CHECK(length(name) between 1 and 80),
	CONSTRAINT "ck_houses_kind" CHECK(kind in ('agent','high_lord')),
	CONSTRAINT "ck_houses_status" CHECK(status in ('active','disabled','archived'))
);
--> statement-breakpoint
CREATE INDEX `idx_houses_status` ON `houses` (`status`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`directory` text NOT NULL,
	`git_info` text DEFAULT '{}' NOT NULL,
	`default_agent_id` text,
	`default_model` text,
	`instructions` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`default_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_projects_directory_abs" CHECK(directory like '/%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_projects_directory` ON `projects` (`directory`);--> statement-breakpoint
CREATE TABLE `provider_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`base_url` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`extra` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "ck_provider_configs_type" CHECK(type in ('opencode','ollama'))
);
--> statement-breakpoint
CREATE INDEX `idx_provider_configs_type` ON `provider_configs` (`type`);--> statement-breakpoint
CREATE TABLE `tasks` (
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
	CONSTRAINT "ck_tasks_status" CHECK(status in ('queued','cancelled')),
	CONSTRAINT "ck_tasks_working_dir_abs" CHECK(working_directory is null or working_directory like '/%')
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_house` ON `tasks` (`house_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_project` ON `tasks` (`project_id`);