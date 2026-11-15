CREATE TABLE `learn_plays` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`station_id` text NOT NULL,
	`track_id` text NOT NULL,
	`status` text NOT NULL,
	`track_msg` text NOT NULL,
	`intro_msg` text,
	`intro_clip` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`retried` integer DEFAULT 0 NOT NULL,
	`planned_at` integer NOT NULL,
	`pushed_at` integer,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `learn_plays_user_status` ON `learn_plays` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `learn_plays_station_status` ON `learn_plays` (`station_id`,`status`);--> statement-breakpoint
CREATE TABLE `learn_song_prefs` (
	`user_id` text NOT NULL,
	`track_id` text NOT NULL,
	`skip` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `track_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_lyrics` (
	`track_id` text PRIMARY KEY NOT NULL,
	`lyrics` text,
	`synced` text,
	`lang` text,
	`source` text,
	`status` text DEFAULT 'not_found' NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_notes` (
	`track_id` text NOT NULL,
	`lang` text NOT NULL,
	`pairs` text,
	`summary` text,
	`intro_text` text,
	`hooks` text,
	`model` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `song_notes_track_lang` ON `song_notes` (`track_id`,`lang`);--> statement-breakpoint
ALTER TABLE `stations` ADD `learn_bag` text;--> statement-breakpoint
ALTER TABLE `stations` ADD `learn_counter` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `learn_mode` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `learn_every` integer DEFAULT 1 NOT NULL;