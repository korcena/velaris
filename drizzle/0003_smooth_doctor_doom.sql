CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_task_id` text NOT NULL,
	`subtask_id` text NOT NULL,
	`source_house_id` text,
	`destination_house_id` text NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`context` text DEFAULT '{}' NOT NULL,
	`artifacts` text DEFAULT '[]' NOT NULL,
	`completion_requirements` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subtask_id`) REFERENCES `subtasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_house_id`) REFERENCES `houses`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`destination_house_id`) REFERENCES `houses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_handoffs_subtask` ON `handoffs` (`subtask_id`);--> statement-breakpoint
CREATE INDEX `idx_handoffs_parent` ON `handoffs` (`parent_task_id`);--> statement-breakpoint
CREATE TABLE `subtasks` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_task_id` text NOT NULL,
	`task_id` text,
	`order_index` integer NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`plan_id` text NOT NULL,
	`title` text NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`completion_requirements` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_subtasks_status" CHECK(status in ('planned','ready','delegated','in_flight','completed','failed','cancelled')),
	CONSTRAINT "ck_subtasks_order" CHECK(order_index >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_subtasks_task` ON `subtasks` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_subtasks_parent` ON `subtasks` (`parent_task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_subtasks_parent_plan` ON `subtasks` (`parent_task_id`,`plan_id`);