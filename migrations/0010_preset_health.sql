ALTER TABLE `presets` ADD `status` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `presets` ADD `fail_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `presets` ADD `checked_at` integer;