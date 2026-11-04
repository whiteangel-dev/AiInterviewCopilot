ALTER TABLE `provider_configs` ADD `key_source` text DEFAULT 'typed' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_configs` ADD `key_label` text;--> statement-breakpoint
ALTER TABLE `provider_configs` ADD `key_expires_at` integer;