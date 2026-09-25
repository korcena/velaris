ALTER TABLE `tasks` ADD `agent_id` text REFERENCES agents(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `idx_tasks_agent` ON `tasks` (`agent_id`);
