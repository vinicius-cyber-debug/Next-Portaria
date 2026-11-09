import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {hasPostgres,withPostgresFixture} from './support/postgres-fixture.mjs';
import {handleApi} from '../lib/server.ts';
import {hashPassword} from '../lib/local-auth.ts';
import {PortoService} from '../lib/porto/service.ts';
import {chargePreview,balance,paymentInput,reportPeriod} from '../lib/porto/finance-domain.mjs';
import {PHOTO_TARIFFS} from '../lib/porto/tarifas-referencia.mjs';
import {createPostgresBackup,postgresInventory} from '../lib/postgres-backup.mjs';

test('Porto financeiro: acesso único não vira diária e registros legados conservam calendário',()=>{
 const entry='2026-11-09T23:59:00-04:00',end='2026-12-01T00:01:00-04:00';assert.equal(chargePreview(entry,end,2500,'acesso').totalCentavos,2500);assert.equal(chargePreview(entry,end,2500,'diaria').totalCentavos,23*2500);
 assert.equal(PHOTO_TARIFFS.modalidade,'acesso');assert.equal(PHOTO_TARIFFS.tarifas.length,10);assert.equal(PHOTO_TARIFFS.tarifas.find(row=>row.codigo==='carreta').valorDiariaCentavos,100000);
 assert.equal(balance(15000,1000,4000).saldoCentavos,10000);assert.throws(()=>balance(15000,0,15001));assert.throws(()=>paymentInput({valorCentavos:100,metodo:'pix',referencia:''}));assert.throws(()=>paymentInput({valorCentavos:100.5,metodo:'dinheiro'}));assert.throws(()=>reportPeriod(new URLSearchParams({inicio:'2025-01-01',fim:'2026-12-01'}),entry));
});

test('Porto financeiro real: adiantamento, saída quitada, estornos, descontos, caixa e relatórios',{skip:!hasPostgres,timeout:120000},async t=>{
 await withPostgresFixture(async({owner,db,localConfig,adminConfig,database,role,password:appPassword})=>{
  const origin='http://127.0.0.1:5199',porto=new PortoService(db,true),cookies={};let actor='admin';
  const call=async(path,{method='GET',body}={})=>{const response=await handleApi(new Request(origin+'/api'+path,{method,headers:{cookie:cookies[actor]||'',...(method==='POST'?{origin,'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),db,{porto});return {status:response.status,data:await response.json()}};
  await call('/session');const password=randomBytes(24).toString('hex'),credential=await hashPassword(password),now=new Date().toISOString();
  for(const role of ['admin','director','gate','finance']){
   await owner.query("INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES($1,$2,$1,$1,'active',$3,$3)",[role,role+'@example.test',now]);await owner.query('INSERT INTO operational_credentials(user_id,username,password_hash,password_salt,password_iterations,password_changed_at,must_change_password) VALUES($1,$1,$2,$3,$4,$5,0)',[role,credential.hash,credential.salt,credential.iterations,now]);
   const response=await handleApi(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:role,password})}),db);assert.equal(response.status,200);cookies[role]=response.headers.get('set-cookie').split(';')[0];
  }
  for(const [collection,id,data] of [['fleet','car',{plate:'QAT1A23',driver:'QA',active:true}],['fleet','car-2',{plate:'QAT2B34',driver:'QA',active:true}],['companies','company',{name:'Empresa fictícia QA',active:true}],['companies','inactive',{name:'Empresa desativada QA',active:false}]])await owner.query('INSERT INTO operational_records(collection,id,body) VALUES($1,$2,$3)',[collection,id,JSON.stringify({id,createdAt:now,updatedAt:now,createdBy:'admin',...data})]);
  const command=(tipo,payload,key=randomUUID())=>call('/porto/comandos',{method:'POST',body:{tipo,payload,idempotencyKey:key}});
  const ok=async promise=>{const result=await promise;assert.equal(result.status,200,JSON.stringify(result.data));return result.data.result};
  await ok(command('TARIFAS_PUBLICAR',{nome:'QA por acesso',modalidade:'acesso',justificativa:'Homologação isolada',tarifas:[{codigo:'carro',nome:'Carro QA',valorDiariaCentavos:15000}]}));
  const enter=async vehicle=>{actor='admin';const request=await ok(command('SOLICITAR_DESCIDA',{veiculoId:vehicle,motoristaNome:'QA',categoriaCodigo:'carro',finalidade:'Teste financeiro',embarcacaoDestino:'Destino QA'}));await ok(command('APROVAR_DESCIDA',{id:request.id,justificativa:'Autorização QA'}));return ok(command('REGISTRAR_ENTRADA',{id:request.id,veiculoConferido:true}))};
  const stay=await enter('car');let firstPayment,secondPayment,discount;
  await t.test('pagador é empresa e saída fica bloqueada antes do recebimento',async()=>{
   actor='gate';assert.equal((await command('DEFINIR_PAGADOR',{id:stay.id,empresaId:'company',justificativa:'QA'})).status,403);assert.equal((await call('/porto/contas')).status,403);assert.equal((await call('/porto/relatorios')).status,403);
   actor='finance';assert.equal((await command('DEFINIR_PAGADOR',{id:stay.id,empresaId:'inactive',justificativa:'QA'})).data.error.code,'COMPANY_INACTIVE');await ok(command('DEFINIR_PAGADOR',{id:stay.id,empresaId:'company',justificativa:'Empresa responsável pelo acesso'}));
   actor='gate';assert.equal((await command('REGISTRAR_SAIDA',{id:stay.id,veiculoConferido:true,justificativa:'Tentativa sem quitação'})).data.error.code,'EXIT_REQUIRES_SETTLEMENT');
   assert.equal((await owner.query('SELECT count(*) AS n FROM porto_cobrancas')).rows[0].n,'0');
   assert.equal(Number((await owner.query("SELECT bruto_centavos FROM porto_saldo($1,clock_timestamp()+interval '30 days')",[stay.id])).rows[0].bruto_centavos),15000);
  });
  await t.test('recebimentos parciais e simultâneos não ultrapassam saldo e geram recibo',async()=>{
   actor='finance';const key=randomUUID(),payload={id:stay.id,valorCentavos:5000,metodo:'pix',referencia:'QA-PIX',justificativa:'Adiantamento parcial'};firstPayment=await ok(command('REGISTRAR_PAGAMENTO',payload,key));assert.equal(firstPayment.tipo,'adiantamento');assert.equal(firstPayment.saldo.saldoCentavos,10000);assert.equal((await command('REGISTRAR_PAGAMENTO',payload,key)).data.replayed,true);
   const results=await Promise.all([command('REGISTRAR_PAGAMENTO',{id:stay.id,valorCentavos:10000,metodo:'dinheiro',justificativa:'Saldo do acesso'}),command('REGISTRAR_PAGAMENTO',{id:stay.id,valorCentavos:10000,metodo:'dinheiro',justificativa:'Recebimento concorrente'})]);assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);secondPayment=results.find(row=>row.status===200).data.result;
   const receipt=(await call('/porto/recibos/'+firstPayment.id)).data;assert.equal(receipt.recibo.empresaNome,'Empresa fictícia QA');assert.equal(receipt.recibo.valorCentavos,5000);assert.equal(receipt.naoFiscal,true);
   assert.equal((await command('DEFINIR_PAGADOR',{id:stay.id,empresaId:'company',justificativa:'Não deve trocar pagador com recebimento'})).data.error.code,'PAYER_FROZEN');
   actor='gate';const row=(await call('/porto/permanencias')).data.rows[0];assert.equal(row.liberadaParaSaida,true);assert.doesNotMatch(JSON.stringify(row),/centavos/i);
  });
  await t.test('saída e cobrança confirmam juntas e não duplicam; saldo pode reabrir por estorno compensatório',async()=>{
   actor='gate';const key=randomUUID(),payload={id:stay.id,veiculoConferido:true,justificativa:'Saída conferida e quitada'},result=await ok(command('REGISTRAR_SAIDA',payload,key));assert.ok(result.cobranca.id);assert.equal('brutoCentavos' in result.cobranca,false);assert.equal((await command('REGISTRAR_SAIDA',payload,key)).data.replayed,true);assert.equal((await command('REGISTRAR_SAIDA',payload)).status,409);
   const invoice=(await owner.query('SELECT * FROM porto_cobrancas')).rows[0];assert.equal(Number(invoice.bruto_centavos),15000);assert.equal(invoice.quantidade,1);assert.equal(invoice.modalidade,'acesso');assert.equal((await owner.query('SELECT status FROM porto_permanencias WHERE id=$1',[stay.id])).rows[0].status,'encerrada');
   actor='finance';assert.equal((await command('ESTORNAR_PAGAMENTO',{id:stay.id,origemId:firstPayment.id,valorCentavos:1000,justificativa:'Sem autorização'})).status,403);
   actor='director';await ok(command('ESTORNAR_PAGAMENTO',{id:stay.id,origemId:firstPayment.id,valorCentavos:1000,justificativa:'Correção autorizada de recebimento'}));assert.equal((await call('/porto/contas/'+stay.id)).data.conta.saldoCentavos,1000);
   assert.equal((await command('ESTORNAR_PAGAMENTO',{id:stay.id,origemId:firstPayment.id,valorCentavos:5000,justificativa:'Excede recebimento restante'})).status,409);
   actor='finance';const paid=await ok(command('REGISTRAR_PAGAMENTO',{id:stay.id,valorCentavos:1000,metodo:'pix',referencia:'QA-CORRECAO',justificativa:'Quitação do saldo reaberto'}));assert.equal(paid.tipo,'pagamento');
  });
  let secondStay;
  await t.test('desconto e estorno de desconto preservam o histórico e exigem autorização',async()=>{
   secondStay=await enter('car-2');actor='finance';await ok(command('DEFINIR_PAGADOR',{id:secondStay.id,empresaId:'company',justificativa:'Pagador da segunda operação'}));assert.equal((await command('CONCEDER_DESCONTO',{id:secondStay.id,valorCentavos:1000,justificativa:'Sem permissão'})).status,403);
   actor='director';discount=await ok(command('CONCEDER_DESCONTO',{id:secondStay.id,valorCentavos:1000,justificativa:'Desconto autorizado pela diretoria'}));await ok(command('ESTORNAR_DESCONTO',{id:secondStay.id,origemId:discount.id,justificativa:'Cancelamento autorizado do desconto'}));assert.equal((await command('ESTORNAR_DESCONTO',{id:secondStay.id,origemId:discount.id,justificativa:'Repetido'})).status,409);
   await ok(command('CONCEDER_DESCONTO',{id:secondStay.id,valorCentavos:15000,justificativa:'Isenção integral autorizada e rastreada'}));actor='gate';await ok(command('REGISTRAR_SAIDA',{id:secondStay.id,veiculoConferido:true,justificativa:'Saída com isenção autorizada'}));
   await assert.rejects(db.pool.query('DELETE FROM porto_pagamentos'));await assert.rejects(db.pool.query('UPDATE porto_cobrancas SET bruto_centavos=1'));
  });
  await t.test('relatório separa cobrado, recebido, estornado e saldo; caixa fecha movimentos uma única vez',async()=>{
   actor='finance';const report=await call('/porto/relatorios');assert.equal(report.status,200,JSON.stringify(report.data));assert.equal(report.data.resumo.cobradoBrutoCentavos,30000);assert.equal(report.data.resumo.recebidoBrutoCentavos,16000);assert.equal(report.data.resumo.estornadoCentavos,1000);assert.equal(report.data.resumo.recebidoLiquidoCentavos,15000);assert.equal(report.data.categorias[0].recebidoLiquidoCentavos,15000);
   const csv=await call('/porto/relatorios/exportar');assert.equal(csv.status,200);assert.match(csv.data.csv,/15000/);
   const cash=await call('/porto/caixa');assert.equal(cash.data.aberto.quantidade,4);assert.equal(cash.data.aberto.totalCentavos,15000);
   const key=randomUUID(),payload={saldoInicialCentavos:0,dinheiroConferidoCentavos:10000,justificativa:'Conferência de todos os movimentos do Porto'};const closed=await ok(command('FECHAR_CAIXA',payload,key));assert.equal(closed.diferencaCentavos,0);assert.equal((await command('FECHAR_CAIXA',payload,key)).data.replayed,true);assert.equal((await command('FECHAR_CAIXA',payload)).data.error.code,'EMPTY_CASH');assert.equal((await call('/porto/caixa')).data.aberto.quantidade,0);
   actor='director';assert.equal((await call('/porto/caixa')).status,403);
  });
  await t.test('falha na emissão da cobrança reverte saída; restrição diferida exige cobrança e saldo zero',async()=>{
   const third=await enter('car');actor='finance';await ok(command('DEFINIR_PAGADOR',{id:third.id,empresaId:'company',justificativa:'QA'}));await ok(command('REGISTRAR_PAGAMENTO',{id:third.id,valorCentavos:15000,metodo:'dinheiro',justificativa:'Adiantamento QA'}));
   await owner.query("CREATE FUNCTION qa_invoice_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA_FAILURE'; END; $$;CREATE TRIGGER qa_invoice_failure BEFORE INSERT ON porto_cobrancas FOR EACH ROW EXECUTE FUNCTION qa_invoice_failure()");
   actor='gate';assert.equal((await command('REGISTRAR_SAIDA',{id:third.id,veiculoConferido:true,justificativa:'QA falha atômica'})).status,500);assert.equal((await owner.query('SELECT status FROM porto_permanencias WHERE id=$1',[third.id])).rows[0].status,'em_andamento');assert.equal((await owner.query('SELECT count(*) AS n FROM porto_cobrancas WHERE permanencia_id=$1',[third.id])).rows[0].n,'0');
   await owner.query('DROP TRIGGER qa_invoice_failure ON porto_cobrancas;DROP FUNCTION qa_invoice_failure()');
   await assert.rejects(db.pool.query("UPDATE porto_permanencias SET status='encerrada',saida_em=clock_timestamp(),saida_operador_id='admin' WHERE id=$1",[third.id]));
   await ok(command('REGISTRAR_SAIDA',{id:third.id,veiculoConferido:true,justificativa:'Nova tentativa após corrigir emissão'}));
  });
  await t.test('tabela legada conserva modalidade e calendário mesmo após uma publicação nova por acesso',async()=>{
   await owner.query("INSERT INTO porto_tabelas_tarifarias(id,unidade_id,nome,vigencia_inicio,publicado_por,justificativa) VALUES('legacy-table','settings','Tabela histórica QA',clock_timestamp(),'admin','Simulação de tabela anterior à migração financeira');INSERT INTO porto_tarifas(id,tabela_id,categoria_codigo,categoria_nome,diaria_centavos) VALUES('legacy-rate','legacy-table','carro','Carro legado QA',9000)");
   const legacy=await enter('car');assert.equal(legacy.modalidadeCobranca,'diaria');
   await ok(command('TARIFAS_PUBLICAR',{nome:'Novo acesso QA',modalidade:'acesso',justificativa:'Preservação de contratos anteriores',tarifas:[{codigo:'carro',nome:'Carro QA',valorDiariaCentavos:10000}]}));
   assert.equal(Number((await owner.query("SELECT s.bruto_centavos FROM porto_permanencias p CROSS JOIN LATERAL porto_saldo(p.id,p.entrada_em+interval '2 days') s WHERE p.id=$1",[legacy.id])).rows[0].bruto_centavos),27000);
  });
  await t.test('recuperação criptografada conserva cobranças encerradas, adiantamentos, estornos e caixa',{skip:!localConfig},async()=>{
   const temporary=await mkdtemp(join(tmpdir(),'portaria-finance-backup-'));
   try{
    const adminFile=join(temporary,'admin-qa.json'),mediaRoot=join(temporary,'media');await mkdir(mediaRoot);await writeFile(adminFile,JSON.stringify(adminConfig),{mode:0o600});
    const config={...localConfig,dataRoot:temporary,adminFile,mediaRoot,database:{...adminConfig,database,user:role,password:appPassword}},before=await postgresInventory(owner),result=await createPostgresBackup({config,destination:join(temporary,'backup'),keyFile:join(temporary,'recovery.key'),quiesced:true});
    assert.equal(result.status,'verified');assert.deepEqual(await postgresInventory(owner),before);assert.equal((await owner.query('SELECT count(*) AS n FROM porto_cobrancas')).rows[0].n,'3');
   }finally{if(!resolve(temporary).startsWith(resolve(tmpdir())+sep))throw Error('Pasta financeira QA fora do diretório temporário.');await rm(temporary,{recursive:true,force:true})}
  });
  assert.ok(secondPayment.id);
 });
});
