-- New vehicle-port domain. Does not enable retired vessel/stay/financial collections.
CREATE TABLE porto_tabelas_tarifarias (
 id TEXT PRIMARY KEY, unidade_id TEXT NOT NULL REFERENCES operational_settings(id) DEFERRABLE INITIALLY DEFERRED,
 nome TEXT NOT NULL CHECK(length(nome) BETWEEN 1 AND 120), vigencia_inicio TIMESTAMPTZ NOT NULL,
 publicado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), publicado_por TEXT NOT NULL REFERENCES operational_users(id),
 justificativa TEXT NOT NULL CHECK(length(justificativa) BETWEEN 1 AND 500),
 UNIQUE(unidade_id,vigencia_inicio), UNIQUE(id,unidade_id)
);
CREATE TABLE porto_tarifas (
 id TEXT PRIMARY KEY, tabela_id TEXT NOT NULL REFERENCES porto_tabelas_tarifarias(id),
 categoria_codigo TEXT NOT NULL CHECK(categoria_codigo ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
 categoria_nome TEXT NOT NULL CHECK(length(categoria_nome) BETWEEN 1 AND 100),
 diaria_centavos BIGINT NOT NULL CHECK(diaria_centavos BETWEEN 1 AND 1000000000),
 UNIQUE(tabela_id,categoria_codigo), UNIQUE(id,tabela_id,categoria_codigo,diaria_centavos)
);
CREATE TABLE porto_solicitacoes (
 id TEXT PRIMARY KEY, unidade_id TEXT NOT NULL REFERENCES operational_settings(id) DEFERRABLE INITIALLY DEFERRED,
 veiculo_colecao TEXT NOT NULL DEFAULT 'fleet' CHECK(veiculo_colecao='fleet'), veiculo_id TEXT NOT NULL,
 placa TEXT NOT NULL, motorista_colecao TEXT NOT NULL DEFAULT 'people' CHECK(motorista_colecao='people'), motorista_id TEXT,
 motorista_nome TEXT NOT NULL CHECK(length(motorista_nome) BETWEEN 1 AND 150), categoria_codigo TEXT NOT NULL,
 finalidade TEXT NOT NULL CHECK(length(finalidade) BETWEEN 1 AND 500), embarcacao_destino TEXT NOT NULL CHECK(length(embarcacao_destino) BETWEEN 1 AND 150), observacoes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','aprovada','recusada')),
 solicitada_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), solicitada_por TEXT NOT NULL REFERENCES operational_users(id),
 decidida_em TIMESTAMPTZ, decidida_por TEXT REFERENCES operational_users(id), motivo_decisao TEXT,
 FOREIGN KEY(veiculo_colecao,veiculo_id) REFERENCES operational_records(collection,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(motorista_colecao,motorista_id) REFERENCES operational_records(collection,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((status='pendente' AND decidida_em IS NULL AND decidida_por IS NULL AND motivo_decisao IS NULL) OR (status<>'pendente' AND decidida_em>=solicitada_em AND decidida_por IS NOT NULL AND length(motivo_decisao) BETWEEN 1 AND 500)),
 UNIQUE(id,unidade_id,veiculo_id)
);
CREATE TABLE porto_permanencias (
 id TEXT PRIMARY KEY, unidade_id TEXT NOT NULL, solicitacao_id TEXT NOT NULL UNIQUE, veiculo_id TEXT NOT NULL,
 placa TEXT NOT NULL, motorista_id TEXT, motorista_nome TEXT NOT NULL,
 tarifa_id TEXT NOT NULL, tabela_tarifaria_id TEXT NOT NULL, categoria_codigo TEXT NOT NULL, categoria_nome TEXT NOT NULL,
 valor_diaria_centavos BIGINT NOT NULL CHECK(valor_diaria_centavos BETWEEN 1 AND 1000000000),
 entrada_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), saida_em TIMESTAMPTZ,
 status TEXT NOT NULL DEFAULT 'em_andamento' CHECK(status IN ('em_andamento','encerrada')),
 entrada_operador_id TEXT NOT NULL REFERENCES operational_users(id), saida_operador_id TEXT REFERENCES operational_users(id),
 FOREIGN KEY(solicitacao_id,unidade_id,veiculo_id) REFERENCES porto_solicitacoes(id,unidade_id,veiculo_id),
 FOREIGN KEY(tabela_tarifaria_id,unidade_id) REFERENCES porto_tabelas_tarifarias(id,unidade_id),
 FOREIGN KEY(tarifa_id,tabela_tarifaria_id,categoria_codigo,valor_diaria_centavos) REFERENCES porto_tarifas(id,tabela_id,categoria_codigo,diaria_centavos),
 CHECK((status='em_andamento' AND saida_em IS NULL AND saida_operador_id IS NULL) OR (status='encerrada' AND saida_em>=entrada_em AND saida_operador_id IS NOT NULL))
);
CREATE UNIQUE INDEX porto_veiculo_aberto_unico ON porto_permanencias(unidade_id,veiculo_id) WHERE saida_em IS NULL;
CREATE INDEX porto_solicitacoes_lista ON porto_solicitacoes(unidade_id,status,solicitada_em DESC,id);
CREATE INDEX porto_permanencias_lista ON porto_permanencias(unidade_id,status,entrada_em DESC,id);
CREATE TABLE porto_eventos (
 sequencia BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT NOT NULL UNIQUE,
 unidade_id TEXT NOT NULL REFERENCES operational_settings(id) DEFERRABLE INITIALLY DEFERRED,
 entidade_id TEXT NOT NULL, acao TEXT NOT NULL, ocorrido_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 ator_id TEXT NOT NULL REFERENCES operational_users(id), ator_nome TEXT NOT NULL,
 dados JSONB NOT NULL CHECK(jsonb_typeof(dados)='object')
);
CREATE INDEX porto_eventos_lista ON porto_eventos(unidade_id,sequencia DESC);
CREATE TABLE porto_comandos (
 id TEXT PRIMARY KEY, ator_id TEXT NOT NULL REFERENCES operational_users(id), hash TEXT NOT NULL,
 resultado JSONB NOT NULL, criado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION porto_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PORTO_IMMUTABLE' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER porto_tabela_imutavel BEFORE UPDATE OR DELETE ON porto_tabelas_tarifarias FOR EACH ROW EXECUTE FUNCTION porto_imutavel();
CREATE TRIGGER porto_tarifa_imutavel BEFORE UPDATE OR DELETE ON porto_tarifas FOR EACH ROW EXECUTE FUNCTION porto_imutavel();
CREATE TRIGGER porto_evento_imutavel BEFORE UPDATE OR DELETE ON porto_eventos FOR EACH ROW EXECUTE FUNCTION porto_imutavel();
CREATE TRIGGER porto_comando_imutavel BEFORE UPDATE OR DELETE ON porto_comandos FOR EACH ROW EXECUTE FUNCTION porto_imutavel();
-- Phase 1 never closes a stay without its invoice. Phase 2 must replace this guard atomically with billing.
CREATE TRIGGER porto_permanencia_imutavel BEFORE UPDATE OR DELETE ON porto_permanencias FOR EACH ROW EXECUTE FUNCTION porto_imutavel();
CREATE FUNCTION porto_decisao_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'pendente' OR NEW.status NOT IN ('aprovada','recusada') OR
   (to_jsonb(NEW)-ARRAY['status','decidida_em','decidida_por','motivo_decisao']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['status','decidida_em','decidida_por','motivo_decisao']) THEN
   RAISE EXCEPTION 'PORTO_REQUEST_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER porto_decisao_guard BEFORE UPDATE OR DELETE ON porto_solicitacoes FOR EACH ROW EXECUTE FUNCTION porto_decisao_guard();
CREATE FUNCTION porto_entrada_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r porto_solicitacoes; t porto_tarifas;
BEGIN
 SELECT * INTO r FROM porto_solicitacoes WHERE id=NEW.solicitacao_id;
 SELECT * INTO t FROM porto_tarifas WHERE id=NEW.tarifa_id;
 IF r.status IS DISTINCT FROM 'aprovada' OR (NEW.placa,NEW.motorista_id,NEW.motorista_nome,NEW.categoria_codigo) IS DISTINCT FROM (r.placa,r.motorista_id,r.motorista_nome,r.categoria_codigo) OR NEW.categoria_nome IS DISTINCT FROM t.categoria_nome THEN
  RAISE EXCEPTION 'PORTO_ENTRY_INVALID' USING ERRCODE='23514';
 END IF;
 IF NEW.tabela_tarifaria_id IS DISTINCT FROM (SELECT id FROM porto_tabelas_tarifarias WHERE unidade_id=NEW.unidade_id AND vigencia_inicio<=NEW.entrada_em ORDER BY vigencia_inicio DESC LIMIT 1) THEN
  RAISE EXCEPTION 'PORTO_TARIFF_INVALID' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER porto_entrada_guard BEFORE INSERT ON porto_permanencias FOR EACH ROW EXECUTE FUNCTION porto_entrada_guard();
CREATE FUNCTION porto_assert_json_restore() RETURNS INTEGER LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM porto_tabelas_tarifarias) OR EXISTS(SELECT 1 FROM porto_solicitacoes) THEN
  RAISE EXCEPTION 'PORTO_FULL_RESTORE_REQUIRED';
 END IF;
 RETURN 1;
END;
$$;
