CREATE TABLE `knowledge_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`base_id` text NOT NULL,
	`profile_id` text,
	`items_hash` text NOT NULL,
	`result` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `knowledge_analyses_base_idx` ON `knowledge_analyses` (`base_id`);--> statement-breakpoint
CREATE TABLE `knowledge_bases` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_items` (
	`id` text PRIMARY KEY NOT NULL,
	`base_id` text NOT NULL,
	`kind` text NOT NULL,
	`category` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `knowledge_items_base_idx` ON `knowledge_items` (`base_id`);--> statement-breakpoint
CREATE TABLE `prepared_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`question` text NOT NULL,
	`variants` text NOT NULL,
	`category` text NOT NULL,
	`answer` text NOT NULL,
	`status` text NOT NULL,
	`origin` text NOT NULL,
	`model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `prepared_answers_profile_idx` ON `prepared_answers` (`profile_id`);--> statement-breakpoint
CREATE TABLE `profile_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`version` integer NOT NULL,
	`origin` text NOT NULL,
	`document_id` text,
	`data` text NOT NULL,
	`brief` text NOT NULL,
	`model` text,
	`prompt_version` text,
	`duration_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `resume_documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_versions_profile_version_unique` ON `profile_versions` (`profile_id`,`version`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resume_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`file_name` text NOT NULL,
	`kind` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`content` blob NOT NULL,
	`text` text NOT NULL,
	`page_count` integer,
	`text_quality` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resume_documents_profile_idx` ON `resume_documents` (`profile_id`);