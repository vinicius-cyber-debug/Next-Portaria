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
