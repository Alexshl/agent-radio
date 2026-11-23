ALTER TABLE `messages` ADD `spoken_text` text;--> statement-breakpoint
ALTER TABLE `users` ADD `translate_messages` integer DEFAULT true NOT NULL;