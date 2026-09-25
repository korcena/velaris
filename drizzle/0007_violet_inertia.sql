CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`is_seeded` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "ck_templates_kind" CHECK(kind in ('house','project'))
);
--> statement-breakpoint
CREATE INDEX `idx_templates_kind` ON `templates` (`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_templates_name_kind` ON `templates` (`kind`,`name`);