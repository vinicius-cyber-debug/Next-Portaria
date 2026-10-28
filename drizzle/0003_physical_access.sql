ALTER TABLE `operational_records` ADD `record_person_id` text GENERATED ALWAYS AS (json_extract(body, '$.personId')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `operational_records` ADD `record_status` text GENERATED ALWAYS AS (json_extract(body, '$.status')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `operational_records` ADD `record_area_id` text GENERATED ALWAYS AS (json_extract(body, '$.areaId')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `operational_records` ADD `record_expected_at` text GENERATED ALWAYS AS (json_extract(body, '$.expectedAt')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `operational_records` ADD `record_category` text GENERATED ALWAYS AS (json_extract(body, '$.category')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `operational_records` ADD `record_active` integer GENERATED ALWAYS AS (json_extract(body, '$.active')) VIRTUAL;--> statement-breakpoint
ALTER TABLE `operational_records` ADD `record_stay_id` text GENERATED ALWAYS AS (json_extract(body, '$.stayId')) VIRTUAL;--> statement-breakpoint
CREATE UNIQUE INDEX `operational_visit_person_inside_unique` ON `operational_records` (`record_person_id`) WHERE "operational_records"."collection" = 'visitors' AND "operational_records"."record_status" = 'inside' AND "operational_records"."record_person_id" IS NOT NULL AND "operational_records"."record_person_id" <> '';--> statement-breakpoint
CREATE INDEX `operational_visitors_destination_idx` ON `operational_records` (`record_area_id`,`record_status`,`record_expected_at`) WHERE "operational_records"."collection" = 'visitors';--> statement-breakpoint
CREATE INDEX `operational_people_category_idx` ON `operational_records` (`record_category`,`record_active`) WHERE "operational_records"."collection" = 'people';--> statement-breakpoint
CREATE INDEX `operational_manifest_stay_idx` ON `operational_records` (`record_stay_id`,`record_active`) WHERE "operational_records"."collection" = 'crewManifests';