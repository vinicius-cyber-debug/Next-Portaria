-- Organizational sectors do not change accessAreas, directory groups or device policies.
CREATE TABLE exit_sectors (
 id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 name_key TEXT NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE,
 leader_id TEXT REFERENCES operational_users(id), substitute_id TEXT REFERENCES operational_users(id),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_by TEXT REFERENCES operational_users(id),
 CHECK(substitute_id IS NULL OR (leader_id IS NOT NULL AND substitute_id<>leader_id))
);
INSERT INTO exit_sectors(id,name,name_key) VALUES
 ('sec_recepcao_pescados','Recepção de Pescados','recepcao de pescados'),
 ('sec_beneficiamento','Salão Beneficiamento','salao beneficiamento'),
 ('sec_embalagem','Embalagem','embalagem'),
 ('sec_cq','Controle de Qualidade (CQ)','controle de qualidade (cq)'),
 ('sec_estoque','Estoque','estoque'),
 ('sec_camaras','Câmaras Frias','camaras frias'),
 ('sec_expedicao','Expedição','expedicao'),
 ('sec_manutencao','Manutenção','manutencao'),
 ('sec_maquinas','Sala de Máquinas','sala de maquinas'),
 ('sec_almoxarifado','Almoxarifado','almoxarifado'),
 ('sec_rh','Recursos Humanos (RH)','recursos humanos (rh)'),
 ('sec_financeiro','Financeiro','financeiro'),
 ('sec_fiscal','Fiscal','fiscal'),
 ('sec_compras','Compras','compras'),
 ('sec_diretoria','Diretoria','diretoria'),
 ('sec_servicos','Serviços Gerais','servicos gerais'),
 ('sec_refeitorio','Refeitório','refeitorio'),
 ('sec_portaria','Portaria','portaria'),
 ('sec_transporte','Veículos / Transporte','veiculos / transporte'),
 ('sec_ti','Tecnologia da Informação (TI)','tecnologia da informacao (ti)'),
 ('sec_lavanderia','Lavanderia','lavanderia'),
 ('sec_residencia','Residencia','residencia'),
 ('sec_recepcao','Recepção','recepcao');

CREATE TABLE exit_members (
 person_id TEXT PRIMARY KEY, collection TEXT NOT NULL DEFAULT 'people' CHECK(collection='people'),
 sector_id TEXT NOT NULL REFERENCES exit_sectors(id), version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_by TEXT NOT NULL REFERENCES operational_users(id),
 FOREIGN KEY(collection,person_id) REFERENCES operational_records(collection,id)
);
CREATE INDEX exit_members_sector_idx ON exit_members(sector_id,person_id);
CREATE TABLE exit_bindings (
 person_id TEXT PRIMARY KEY REFERENCES exit_members(person_id), source_id TEXT NOT NULL,
 native_user_id TEXT NOT NULL CHECK(native_user_id~'^[1-9][0-9]{0,19}$'),
 manual_rule_id TEXT CHECK(manual_rule_id~'^[1-9][0-9]{0,19}$'),
 target_hash TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT FALSE,
 desired_control BOOLEAN NOT NULL DEFAULT TRUE,
 provisioning_status TEXT NOT NULL DEFAULT 'pending' CHECK(provisioning_status IN ('pending','prepared','error','removing','removed')),
 requested_by TEXT NOT NULL REFERENCES operational_users(id), requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 last_error TEXT,
 verified_at TIMESTAMPTZ, verified_by TEXT REFERENCES operational_users(id),
 evidence TEXT NOT NULL DEFAULT '' CHECK(length(evidence)<=1000),
 UNIQUE(source_id,native_user_id), CHECK(NOT enabled OR (verified_at IS NOT NULL AND verified_by IS NOT NULL AND manual_rule_id IS NOT NULL))
);
CREATE TABLE exit_permits (
 id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES exit_members(person_id),
 sector_id TEXT NOT NULL REFERENCES exit_sectors(id), issued_by TEXT NOT NULL REFERENCES operational_users(id),
 issued_by_name TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 1000),
 issued_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ, revoked_by TEXT REFERENCES operational_users(id), revoke_reason TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','active','applied','expired','revoked','error')),
 last_applied_at TIMESTAMPTZ, last_error TEXT,
 CHECK(expires_at=issued_at+interval '15 minutes'),
 CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL) OR
       (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND length(trim(revoke_reason)) BETWEEN 5 AND 1000))
);
CREATE UNIQUE INDEX exit_permit_active_person_idx ON exit_permits(person_id) WHERE status IN ('pending','active','applied');
CREATE INDEX exit_permit_expiry_idx ON exit_permits(expires_at,status);
CREATE TABLE exit_commands (
 actor_id TEXT NOT NULL REFERENCES operational_users(id), key TEXT NOT NULL, hash TEXT NOT NULL,
 result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(actor_id,key)
);
CREATE TABLE exit_events (
 id TEXT PRIMARY KEY, permit_id TEXT REFERENCES exit_permits(id), sector_id TEXT REFERENCES exit_sectors(id),
 person_id TEXT, action TEXT NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL,
 at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), data JSONB NOT NULL
);
CREATE INDEX exit_events_sector_idx ON exit_events(sector_id,at DESC,id);
CREATE TABLE exit_dispatches (
 source_id TEXT NOT NULL, event_id TEXT NOT NULL, permit_id TEXT NOT NULL REFERENCES exit_permits(id),
 person_id TEXT NOT NULL, device_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('dispatching','confirmed','uncertain','rejected')),
 started_at TIMESTAMPTZ NOT NULL, confirmed_at TIMESTAMPTZ, PRIMARY KEY(source_id,event_id)
);
CREATE TABLE exit_worker_state (
 id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL, mode TEXT NOT NULL,
 status TEXT NOT NULL, heartbeat_at TIMESTAMPTZ NOT NULL, last_success_at TIMESTAMPTZ, error_code TEXT,
 target_hash TEXT
);
CREATE FUNCTION exit_access_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'EXIT_ACCESS_IMMUTABLE' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER exit_events_immutable BEFORE UPDATE OR DELETE ON exit_events FOR EACH ROW EXECUTE FUNCTION exit_access_immutable();
CREATE TRIGGER exit_commands_immutable BEFORE UPDATE OR DELETE ON exit_commands FOR EACH ROW EXECUTE FUNCTION exit_access_immutable();
CREATE FUNCTION exit_permit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['status','revoked_at','revoked_by','revoke_reason','last_applied_at','last_error']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['status','revoked_at','revoked_by','revoke_reason','last_applied_at','last_error']) OR
 (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at,NEW.revoked_by,NEW.revoke_reason) IS DISTINCT FROM (OLD.revoked_at,OLD.revoked_by,OLD.revoke_reason)) THEN
  RAISE EXCEPTION 'EXIT_PERMIT_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER exit_permit_guard BEFORE UPDATE OR DELETE ON exit_permits FOR EACH ROW EXECUTE FUNCTION exit_permit_guard();
CREATE FUNCTION exit_assert_json_restore() RETURNS INTEGER LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM exit_members) OR EXISTS(SELECT 1 FROM exit_events) THEN
  RAISE EXCEPTION 'EXIT_FULL_RESTORE_REQUIRED';
 END IF;
 RETURN 1;
END;
$$;
