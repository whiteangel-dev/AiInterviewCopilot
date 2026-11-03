CREATE TABLE `app_settings` (
	`section` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`key_ref` text,
	`key_hint` text,
	`verification` text DEFAULT 'unverified' NOT NULL,
	`verification_message` text,
	`checked_at` integer,
	`model_catalog` text,
	`models_fetched_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_configs_provider_unique` ON `provider_configs` (`provider`);