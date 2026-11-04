CREATE TABLE `session_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`question_id` text NOT NULL,
	`source` text NOT NULL,
	`trigger` text NOT NULL,
	`length` text NOT NULL,
	`model` text,
	`prepared_answer_id` text,
	`prompt_version` text,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`latency_ms` integer,
	`first_text_ms` integer,
	`duration_ms` integer,
	`input_tokens` integer,
	`cached_tokens` integer,
	`output_tokens` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `session_questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prepared_answer_id`) REFERENCES `prepared_answers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_answers_session_idx` ON `session_answers` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `session_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`heard` text NOT NULL,
	`question` text NOT NULL,
	`type` text,
	`asked_at_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_questions_session_idx` ON `session_questions` (`session_id`,`asked_at_ms`);