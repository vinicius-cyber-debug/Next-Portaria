-- Preserve the modality of Phase 1 data. New publications can explicitly charge per access.
ALTER TABLE porto_tabelas_tarifarias ADD COLUMN modalidade TEXT NOT NULL DEFAULT 'diaria' CHECK(modalidade IN ('diaria','acesso'));
ALTER TABLE porto_permanencias ADD COLUMN modalidade_cobranca TEXT NOT NULL DEFAULT 'diaria' CHECK(modalidade_cobranca IN ('diaria','acesso'));
CREATE OR REPLACE FUNCTION porto_entrada_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r porto_solicitacoes; t porto_tarifas; m TEXT;
BEGIN
 SELECT * INTO r FROM porto_solicitacoes WHERE id=NEW.solicitacao_id;
 SELECT * INTO t FROM porto_tarifas WHERE id=NEW.tarifa_id;
 SELECT modalidade INTO m FROM porto_tabelas_tarifarias WHERE id=NEW.tabela_tarifaria_id;
 IF r.status IS DISTINCT FROM 'aprovada' OR (NEW.placa,NEW.motorista_id,NEW.motorista_nome,NEW.categoria_codigo) IS DISTINCT FROM (r.placa,r.motorista_id,r.motorista_nome,r.categoria_codigo) OR NEW.categoria_nome IS DISTINCT FROM t.categoria_nome OR NEW.modalidade_cobranca IS DISTINCT FROM m THEN RAISE EXCEPTION 'PORTO_ENTRY_INVALID' USING ERRCODE='23514'; END IF;
 IF NEW.tabela_tarifaria_id IS DISTINCT FROM (SELECT id FROM porto_tabelas_tarifarias WHERE unidade_id=NEW.unidade_id AND vigencia_inicio<=NEW.entrada_em ORDER BY vigencia_inicio DESC LIMIT 1) THEN RAISE EXCEPTION 'PORTO_TARIFF_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TABLE porto_pagadores (
 sequencia BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY,
 permanencia_id TEXT NOT NULL REFERENCES porto_permanencias(id),
 empresa_colecao TEXT NOT NULL DEFAULT 'companies' CHECK(empresa_colecao='companies'), empresa_id TEXT NOT NULL,
 empresa_nome TEXT NOT NULL CHECK(length(empresa_nome) BETWEEN 1 AND 150),
 definido_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), definido_por TEXT NOT NULL REFERENCES operational_users(id), justificativa TEXT NOT NULL CHECK(length(justificativa) BETWEEN 1 AND 500),
 FOREIGN KEY(empresa_colecao,empresa_id) REFERENCES operational_records(collection,id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(id,permanencia_id)
);
CREATE INDEX porto_pagadores_conta ON porto_pagadores(permanencia_id,sequencia DESC);
CREATE TABLE porto_cobrancas (
 numero BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, unidade_id TEXT NOT NULL REFERENCES operational_settings(id),
 permanencia_id TEXT NOT NULL UNIQUE REFERENCES porto_permanencias(id), pagador_id TEXT NOT NULL,
 modalidade TEXT NOT NULL CHECK(modalidade IN ('diaria','acesso')), quantidade INTEGER NOT NULL CHECK(quantidade>0),
 valor_unitario_centavos BIGINT NOT NULL CHECK(valor_unitario_centavos>0), bruto_centavos BIGINT NOT NULL CHECK(bruto_centavos>0 AND bruto_centavos<=9007199254740991),
 emitida_em TIMESTAMPTZ NOT NULL, vencimento DATE NOT NULL, emitida_por TEXT NOT NULL REFERENCES operational_users(id),
 FOREIGN KEY(pagador_id,permanencia_id) REFERENCES porto_pagadores(id,permanencia_id)
);
CREATE INDEX porto_cobrancas_periodo ON porto_cobrancas(unidade_id,emitida_em DESC);
CREATE TABLE porto_pagamentos (
 numero BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, permanencia_id TEXT NOT NULL REFERENCES porto_permanencias(id), pagador_id TEXT NOT NULL,
 tipo TEXT NOT NULL CHECK(tipo IN ('adiantamento','pagamento','estorno')), origem_id TEXT REFERENCES porto_pagamentos(id),
 valor_centavos BIGINT NOT NULL CHECK(valor_centavos BETWEEN 1 AND 9007199254740991), metodo TEXT NOT NULL CHECK(metodo IN ('dinheiro','pix','debito','credito','transferencia')),
 referencia TEXT NOT NULL DEFAULT '' CHECK(length(referencia)<=150), justificativa TEXT NOT NULL CHECK(length(justificativa) BETWEEN 1 AND 500),
 ocorrido_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), ator_id TEXT NOT NULL REFERENCES operational_users(id), ator_nome TEXT NOT NULL,
 FOREIGN KEY(pagador_id,permanencia_id) REFERENCES porto_pagadores(id,permanencia_id), CHECK((tipo='estorno')=(origem_id IS NOT NULL))
);
CREATE INDEX porto_pagamentos_conta ON porto_pagamentos(permanencia_id,ocorrido_em,id);
CREATE INDEX porto_pagamentos_origem ON porto_pagamentos(origem_id);
CREATE INDEX porto_pagamentos_periodo ON porto_pagamentos(ocorrido_em,id);
CREATE TABLE porto_ajustes (
 id TEXT PRIMARY KEY, permanencia_id TEXT NOT NULL REFERENCES porto_permanencias(id), tipo TEXT NOT NULL CHECK(tipo IN ('desconto','estorno_desconto')),
 origem_id TEXT UNIQUE REFERENCES porto_ajustes(id), valor_centavos BIGINT NOT NULL CHECK(valor_centavos BETWEEN 1 AND 9007199254740991),
 justificativa TEXT NOT NULL CHECK(length(justificativa) BETWEEN 1 AND 500), ocorrido_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), ator_id TEXT NOT NULL REFERENCES operational_users(id), ator_nome TEXT NOT NULL,
 CHECK((tipo='estorno_desconto')=(origem_id IS NOT NULL))
);
CREATE INDEX porto_ajustes_conta ON porto_ajustes(permanencia_id);
CREATE TABLE porto_caixa_fechamentos (
 numero BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE, id TEXT PRIMARY KEY, unidade_id TEXT NOT NULL REFERENCES operational_settings(id),
 fechado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), fechado_por TEXT NOT NULL REFERENCES operational_users(id), operador_nome TEXT NOT NULL,
 saldo_inicial_centavos BIGINT NOT NULL CHECK(saldo_inicial_centavos BETWEEN 0 AND 9007199254740991), dinheiro_conferido_centavos BIGINT NOT NULL CHECK(dinheiro_conferido_centavos BETWEEN 0 AND 9007199254740991),
 dinheiro_esperado_centavos BIGINT NOT NULL, diferenca_centavos BIGINT NOT NULL, resumo JSONB NOT NULL,
 justificativa TEXT NOT NULL CHECK(length(justificativa) BETWEEN 1 AND 500), CHECK(diferenca_centavos=dinheiro_conferido_centavos-dinheiro_esperado_centavos)
);
CREATE TABLE porto_caixa_itens (fechamento_id TEXT NOT NULL REFERENCES porto_caixa_fechamentos(id),pagamento_id TEXT PRIMARY KEY REFERENCES porto_pagamentos(id));
CREATE FUNCTION porto_saldo(conta TEXT,referencia TIMESTAMPTZ) RETURNS TABLE(bruto_centavos BIGINT,descontos_centavos BIGINT,pago_centavos BIGINT,liquido_centavos BIGINT,saldo_centavos BIGINT) LANGUAGE sql STABLE AS $$
 WITH b AS(SELECT COALESCE(c.bruto_centavos,CASE WHEN p.modalidade_cobranca='acesso' THEN p.valor_diaria_centavos ELSE (((COALESCE(p.saida_em,referencia) AT TIME ZONE 'America/Manaus')::date-(p.entrada_em AT TIME ZONE 'America/Manaus')::date)+1)::bigint*p.valor_diaria_centavos END) AS bruto FROM porto_permanencias p LEFT JOIN porto_cobrancas c ON c.permanencia_id=p.id WHERE p.id=conta),
 d AS(SELECT COALESCE(sum(CASE WHEN tipo='desconto' THEN valor_centavos ELSE -valor_centavos END),0)::bigint AS desconto FROM porto_ajustes WHERE permanencia_id=conta),
 r AS(SELECT COALESCE(sum(CASE WHEN tipo='estorno' THEN -valor_centavos ELSE valor_centavos END),0)::bigint AS pago FROM porto_pagamentos WHERE permanencia_id=conta)
 SELECT b.bruto,d.desconto,r.pago,b.bruto-d.desconto,b.bruto-d.desconto-r.pago FROM b,d,r;
$$;
CREATE FUNCTION porto_saida_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'em_andamento' OR NEW.status<>'encerrada' OR NEW.saida_em IS NULL OR NEW.saida_operador_id IS NULL OR
 (to_jsonb(NEW)-ARRAY['status','saida_em','saida_operador_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','saida_em','saida_operador_id']) THEN RAISE EXCEPTION 'PORTO_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER porto_permanencia_imutavel ON porto_permanencias;
CREATE TRIGGER porto_saida_guard BEFORE UPDATE OR DELETE ON porto_permanencias FOR EACH ROW EXECUTE FUNCTION porto_saida_guard();
CREATE FUNCTION porto_saida_atomica() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p porto_permanencias; c porto_cobrancas; s RECORD; quantidade INTEGER;
BEGIN
 IF TG_TABLE_NAME='porto_cobrancas' THEN SELECT * INTO p FROM porto_permanencias WHERE id=NEW.permanencia_id; ELSE SELECT * INTO p FROM porto_permanencias WHERE id=NEW.id; END IF;
 IF p.status='encerrada' THEN
 SELECT * INTO c FROM porto_cobrancas WHERE permanencia_id=p.id; SELECT * INTO s FROM porto_saldo(p.id,p.saida_em);
 quantidade=CASE WHEN p.modalidade_cobranca='acesso' THEN 1 ELSE (p.saida_em AT TIME ZONE 'America/Manaus')::date-(p.entrada_em AT TIME ZONE 'America/Manaus')::date+1 END;
 IF c.id IS NULL OR c.unidade_id<>p.unidade_id OR c.modalidade<>p.modalidade_cobranca OR c.quantidade<>quantidade OR c.valor_unitario_centavos<>p.valor_diaria_centavos OR c.bruto_centavos<>quantidade::bigint*p.valor_diaria_centavos OR c.emitida_em<>p.saida_em OR s.saldo_centavos<>0 THEN RAISE EXCEPTION 'PORTO_EXIT_UNSETTLED' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='porto_cobrancas' THEN RAISE EXCEPTION 'PORTO_INVOICE_REQUIRES_EXIT' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER porto_saida_atomica AFTER UPDATE ON porto_permanencias DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION porto_saida_atomica();
CREATE CONSTRAINT TRIGGER porto_cobranca_atomica AFTER INSERT ON porto_cobrancas DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION porto_saida_atomica();
CREATE FUNCTION porto_finance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD; p porto_permanencias; o RECORD; restante BIGINT; atual TEXT;
BEGIN
 SELECT * INTO p FROM porto_permanencias WHERE id=NEW.permanencia_id FOR UPDATE;
 SELECT * INTO s FROM porto_saldo(p.id,NEW.ocorrido_em);
 IF TG_TABLE_NAME='porto_pagamentos' THEN
  IF NEW.tipo='estorno' THEN
   SELECT * INTO o FROM porto_pagamentos WHERE id=NEW.origem_id;
   SELECT o.valor_centavos-COALESCE(sum(valor_centavos),0)::bigint INTO restante FROM porto_pagamentos WHERE origem_id=o.id;
   IF o.id IS NULL OR o.tipo='estorno' OR o.permanencia_id<>NEW.permanencia_id OR o.pagador_id<>NEW.pagador_id OR o.metodo<>NEW.metodo OR NEW.valor_centavos>restante THEN RAISE EXCEPTION 'PORTO_REVERSAL_INVALID' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT id INTO atual FROM porto_pagadores WHERE permanencia_id=p.id ORDER BY sequencia DESC LIMIT 1;
   IF NEW.pagador_id IS DISTINCT FROM atual OR NEW.valor_centavos>s.saldo_centavos OR (NEW.tipo='adiantamento')<>(p.status='em_andamento') OR (NEW.metodo<>'dinheiro' AND length(trim(NEW.referencia))=0) THEN RAISE EXCEPTION 'PORTO_PAYMENT_INVALID' USING ERRCODE='23514'; END IF;
  END IF;
 ELSE
  IF NEW.tipo='desconto' THEN
   IF NEW.valor_centavos>s.saldo_centavos THEN RAISE EXCEPTION 'PORTO_DISCOUNT_INVALID' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT * INTO o FROM porto_ajustes WHERE id=NEW.origem_id;
   IF o.id IS NULL OR o.tipo<>'desconto' OR o.permanencia_id<>NEW.permanencia_id OR o.valor_centavos<>NEW.valor_centavos THEN RAISE EXCEPTION 'PORTO_REVERSAL_INVALID' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER porto_pagamento_guard BEFORE INSERT ON porto_pagamentos FOR EACH ROW EXECUTE FUNCTION porto_finance_guard();
CREATE TRIGGER porto_ajuste_guard BEFORE INSERT ON porto_ajustes FOR EACH ROW EXECUTE FUNCTION porto_finance_guard();
CREATE FUNCTION porto_pagador_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s RECORD; p porto_permanencias;
BEGIN
 SELECT * INTO p FROM porto_permanencias WHERE id=NEW.permanencia_id FOR UPDATE;
 SELECT * INTO s FROM porto_saldo(p.id,NEW.definido_em);
 IF p.status<>'em_andamento' OR s.pago_centavos<>0 THEN RAISE EXCEPTION 'PORTO_PAYER_FROZEN' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER porto_pagador_guard BEFORE INSERT ON porto_pagadores FOR EACH ROW EXECUTE FUNCTION porto_pagador_guard();
CREATE TRIGGER porto_pagador_imutavel BEFORE UPDATE OR DELETE ON porto_pagadores FOR EACH ROW EXECUTE FUNCTION porto_imutavel();
CREATE TRIGGER porto_cobranca_imutavel BEFORE UPDATE OR DELETE ON porto_cobrancas FOR EACH ROW EXECUTE FUNCTION porto_imutavel();
CREATE TRIGGER porto_pagamento_imutavel BEFORE UPDATE OR DELETE ON porto_pagamentos FOR EACH ROW EXECUTE FUNCTION porto_imutavel();
CREATE TRIGGER porto_ajuste_imutavel BEFORE UPDATE OR DELETE ON porto_ajustes FOR EACH ROW EXECUTE FUNCTION porto_imutavel();
CREATE TRIGGER porto_caixa_imutavel BEFORE UPDATE OR DELETE ON porto_caixa_fechamentos FOR EACH ROW EXECUTE FUNCTION porto_imutavel();
CREATE TRIGGER porto_caixa_item_imutavel BEFORE UPDATE OR DELETE ON porto_caixa_itens FOR EACH ROW EXECUTE FUNCTION porto_imutavel();
