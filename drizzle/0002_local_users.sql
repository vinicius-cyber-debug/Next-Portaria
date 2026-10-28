-- Usuários e sessões locais; não altera nem remove os registros existentes.
CREATE TABLE IF NOT EXISTS operational_credentials (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES operational_users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 310000,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  password_changed_at TEXT NOT NULL,
  CONSTRAINT username_allowed CHECK(length(username) BETWEEN 3 AND 40)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS operational_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES operational_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS operational_sessions_user_idx ON operational_sessions(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS operational_sessions_expiry_idx ON operational_sessions(expires_at);

--> statement-breakpoint
-- Garante pelo menos um administrador com credencial utilizável, mesmo se houver contas antigas sem senha.
CREATE TRIGGER IF NOT EXISTS operational_last_local_admin_update
BEFORE UPDATE OF role, status ON operational_users
WHEN OLD.role='admin' AND OLD.status='active'
 AND EXISTS (SELECT 1 FROM operational_credentials WHERE user_id=OLD.id)
 AND (NEW.role<>'admin' OR NEW.status<>'active')
 AND (SELECT count(*) FROM operational_users u JOIN operational_credentials c ON c.user_id=u.id WHERE u.role='admin' AND u.status='active')<=1
BEGIN SELECT RAISE(ABORT, 'LAST_ADMIN'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS operational_last_local_admin_delete
BEFORE DELETE ON operational_users
WHEN OLD.role='admin' AND OLD.status='active'
 AND EXISTS (SELECT 1 FROM operational_credentials WHERE user_id=OLD.id)
 AND (SELECT count(*) FROM operational_users u JOIN operational_credentials c ON c.user_id=u.id WHERE u.role='admin' AND u.status='active')<=1
BEGIN SELECT RAISE(ABORT, 'LAST_ADMIN'); END;
