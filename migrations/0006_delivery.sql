ALTER TABLE `messages` ADD `pushed_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `ended_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `stations` ADD `last_listener_seen_at` integer;