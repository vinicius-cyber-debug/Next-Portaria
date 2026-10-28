CREATE TABLE `operational_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT "audit_json" CHECK(json_valid("operational_audit"."body"))
);
--> statement-breakpoint
CREATE TABLE `operational_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`hash` text NOT NULL,
	`result` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "command_json" CHECK(json_valid("operational_commands"."result"))
);
--> statement-breakpoint
CREATE TABLE `operational_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`accepted_at` text,
	`accepted_by` text,
	CONSTRAINT "invite_role" CHECK("operational_invites"."role" IN ('admin','director','gate','operations','finance','reader')),
	CONSTRAINT "invite_status" CHECK("operational_invites"."status" IN ('pending','accepted','revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_invites_email_unique` ON `operational_invites` (`email`);--> statement-breakpoint
CREATE TABLE `operational_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "singleton_meta" CHECK("operational_meta"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `operational_mutation_guard` (
	`token` text PRIMARY KEY NOT NULL,
	`expected_revision` integer NOT NULL,
	`actor_id` text NOT NULL,
	`actor_role` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operational_records` (
	`collection` text NOT NULL,
	`id` text NOT NULL,
	`body` text NOT NULL,
	PRIMARY KEY(`collection`, `id`),
	CONSTRAINT "record_json" CHECK(json_valid("operational_records"."body"))
);
--> statement-breakpoint
CREATE TABLE `operational_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT "settings_json" CHECK(json_valid("operational_settings"."body"))
);
--> statement-breakpoint
CREATE TABLE `operational_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "user_role" CHECK("operational_users"."role" IN ('admin','director','gate','operations','finance','reader')),
	CONSTRAINT "user_status" CHECK("operational_users"."status" IN ('active','pending','disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operational_users_email_unique` ON `operational_users` (`email`);
--> statement-breakpoint
-- Executar após a migration gerada pelo Drizzle. Não contém dados demonstrativos.
CREATE TRIGGER IF NOT EXISTS operational_revision_guard
BEFORE INSERT ON operational_mutation_guard
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM operational_meta WHERE id = 1 AND revision = NEW.expected_revision
  ) THEN RAISE(ABORT, 'REVISION_CONFLICT') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM operational_users
    WHERE id = NEW.actor_id AND role = NEW.actor_role AND status = 'active'
  ) THEN RAISE(ABORT, 'ACCESS_REVOKED') END;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS operational_audit_no_update
BEFORE UPDATE ON operational_audit
BEGIN SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS operational_audit_no_delete
BEFORE DELETE ON operational_audit
BEGIN SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS operational_last_admin_update
BEFORE UPDATE OF role, status ON operational_users
WHEN OLD.role = 'admin' AND OLD.status = 'active'
 AND (NEW.role <> 'admin' OR NEW.status <> 'active')
 AND (SELECT count(*) FROM operational_users WHERE role = 'admin' AND status = 'active') <= 1
BEGIN SELECT RAISE(ABORT, 'LAST_ADMIN'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS operational_last_admin_delete
BEFORE DELETE ON operational_users
WHEN OLD.role = 'admin' AND OLD.status = 'active'
 AND (SELECT count(*) FROM operational_users WHERE role = 'admin' AND status = 'active') <= 1
BEGIN SELECT RAISE(ABORT, 'LAST_ADMIN'); END;

