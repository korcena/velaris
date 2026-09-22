ALTER TABLE `agent_messages` ADD `relayed_at` text;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `provider_message_id` text;--> statement-breakpoint
CREATE INDEX `idx_agent_messages_provider` ON `agent_messages` (`provider_message_id`);--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `relayed_at` text;