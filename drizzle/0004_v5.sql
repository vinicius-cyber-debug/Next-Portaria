CREATE TABLE `operational_changes` (
	`revision` integer PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT "change_json" CHECK(json_valid("operational_changes"."body"))
);
--> statement-breakpoint
CREATE INDEX `operational_changes_created_idx` ON `operational_changes` (`created_at`);--> statement-breakpoint
ALTER TABLE `operational_credentials` ADD `must_change_password` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `operational_records` ADD `record_responsible_user_id` text GENERATED ALWAYS AS (json_extract(body, '$.responsibleUserId')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `operational_records` ADD `record_valid_until` text GENERATED ALWAYS AS (json_extract(body, '$.validUntil')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `operational_records` ADD `record_updated_at` text GENERATED ALWAYS AS (json_extract(body, '$.updatedAt')) VIRTUAL;--> statement-breakpoint
CREATE INDEX `operational_visitors_responsible_idx` ON `operational_records` (`record_responsible_user_id`,`record_status`,`record_expected_at`) WHERE "operational_records"."collection" = 'visitors';--> statement-breakpoint
CREATE INDEX `operational_requirements_validity_idx` ON `operational_records` (`record_person_id`,`record_status`,`record_valid_until`) WHERE "operational_records"."collection" = 'personRequirements';--> statement-breakpoint
CREATE INDEX `operational_records_updated_idx` ON `operational_records` (`collection`,`record_updated_at`);