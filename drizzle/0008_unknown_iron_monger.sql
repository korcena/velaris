CREATE INDEX `idx_tasks_created` ON `tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_created` ON `tasks` (`status`,`created_at`);