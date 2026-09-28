ALTER TABLE `tasks` ADD `deleted_at` text;--> statement-breakpoint
CREATE INDEX `idx_tasks_deleted` ON `tasks` (`deleted_at`);