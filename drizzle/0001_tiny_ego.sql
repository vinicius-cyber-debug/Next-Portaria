CREATE TABLE `operational_access` (
	`user_id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT "access_json" CHECK(json_valid("operational_access"."body"))
);
--> statement-breakpoint
CREATE TABLE `operational_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_attachments_object_key_unique` ON `operational_attachments` (`object_key`);--> statement-breakpoint
CREATE TABLE `operational_backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`status` text NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT "backup_run_json" CHECK(json_valid("operational_backup_runs"."body"))
);
--> statement-breakpoint
CREATE TABLE `operational_continuity_config` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT "continuity_json" CHECK(json_valid("operational_continuity_config"."body"))
);
--> statement-breakpoint
CREATE TABLE `operational_job_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`lease_until` text NOT NULL,
	`token` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operational_notification_reads` (
	`notification_id` text NOT NULL,
	`user_id` text NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`notification_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `operational_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` text NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT "notification_json" CHECK(json_valid("operational_notifications"."body"))
);
--> statement-breakpoint
CREATE TABLE `operational_passes` (
	`id` text PRIMARY KEY NOT NULL,
	`visitor_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_passes_visitor_id_unique` ON `operational_passes` (`visitor_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `operational_passes_token_hash_unique` ON `operational_passes` (`token_hash`);