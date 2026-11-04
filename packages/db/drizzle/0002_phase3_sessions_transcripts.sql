CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`profile_id` text,
	`profile_version_id` text,
	`profile_name` text,
	`knowledge_base_id` text,
	`knowledge_base_name` text,
	`context` text NOT NULL,
	`vocabulary` text NOT NULL,
	`audio` text NOT NULL,
	`stats` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`profile_version_id`) REFERENCES `profile_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sessions_started_idx` ON `sessions` (`started_at`);--> statement-breakpoint
CREATE TABLE `transcript_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`channel` text NOT NULL,
	`text` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `transcript_segments_session_idx` ON `transcript_segments` (`session_id`,`start_ms`);