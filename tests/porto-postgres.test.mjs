import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {hasPostgres,withPostgresFixture} from './support/postgres-fixture.mjs';
import {handleApi} from '../lib/server.ts';
import {hashPassword} from '../lib/local-auth.ts';
import {PortoService} from '../lib/porto/service.ts';
import {createPostgresBackup,restorePostgresBackup,postgresInventory} from '../lib/postgres-backup.mjs';

test('Porto PostgreSQL: fundação isolada, permissões, snapshots, concorrência e auditoria',{skip:!hasPostgres,timeout:120000},async t=>{
 await withPostgresFixture(async({owner,db,database,role,password:appPassword,adminConfig,localConfig,control,token})=>{
  const origin='http://127.0.0.1:5198',porto=new PortoService(db,true),cookies={};let actor='admin';
  const call=async(path,{method='GET',body,headers={},resource=porto}={})=>{
   const response=await handleApi(new Request(origin+'/api'+path,{method,headers:{cookie:cookies[actor]||'',...(method==='POST'?{origin,'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}),db,{porto:resource});return {status:response.status,data:await response.json()};
  };
  await call('/session');const password=randomBytes(24).toString('hex'),secret=await hashPassword(password),now=new Date().toISOString();
  for(const role of ['admin','director','gate','finance','reader','operations']){
   await owner.query('INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES($1,$2,$1,$1,\'active\',$3,$3)',[role,role+'@example.test',now]);
   await owner.query('INSERT INTO operational_credentials(user_id,username,password_hash,password_salt,password_iterations,password_changed_at,must_change_password) VALUES($1,$2,$3,$4,$5,$6,0)',[role,'porto.'+role,secret.hash,secret.salt,secret.iterations,now]);
   const response=await handleApi(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'porto.'+role,password})}),db);assert.equal(response.status,200);cookies[role]=response.headers.get('set-cookie').split(';')[0];
  }
  for(const [collection,id,body] of [['fleet','car-qa',{plate:'QAT1A23',driver:'Motorista QA',active:true}],['people','person-qa',{name:'Motorista QA',category:'driver',active:true,securityStatus:'cleared'}]])await owner.query('INSERT INTO operational_records(collection,id,body) VALUES($1,$2,$3)',[collection,id,JSON.stringify({id,createdAt:now,updatedAt:now,createdBy:'admin',updatedBy:'admin',...body})]);
  const command=(tipo,payload,idempotencyKey=randomUUID())=>call('/porto/comandos',{method:'POST',body:{tipo,payload,idempotencyKey}});
  const publish=price=>command('TARIFAS_PUBLICAR',{nome:'Tabela fictícia QA',justificativa:'Apenas testes isolados',tarifas:[{codigo:'carro',nome:'Carro QA',valorDiariaCentavos:price}]});
  const request=()=>command('SOLICITAR_DESCIDA',{veiculoId:'car-qa',motoristaId:'person-qa',motoristaNome:'Motorista QA',categoriaCodigo:'carro',finalidade:'Abastecimento QA',embarcacaoDestino:'Embarcação fictícia QA'});
  const approve=id=>command('APROVAR_DESCIDA',{id,justificativa:'Descida QA autorizada'});
  let requestId,stayId;
  await t.test('administrador provisiona financeiro somente com Porto habilitado, sem reativar comandos antigos',async()=>{
   actor='admin';const body={action:'create_local',name:'Financeiro QA',email:'novo.financeiro@example.test',username:'financeiro.qa',password,idempotencyKey:randomUUID(),role:'finance'};
   const blocked=await call('/users',{method:'POST',body,resource:new PortoService(db,false)});assert.equal(blocked.data.error.code,'MODULE_REMOVED');
   const created=await call('/users',{method:'POST',body});assert.equal(created.status,200,JSON.stringify(created.data));assert.equal(created.data.result.role,'finance');
   actor='finance';const retired=await call('/commands',{method:'POST',body:{type:'CHARGE_PAYMENT',payload:{},idempotencyKey:randomUUID(),revision:0}});assert.notEqual(retired.status,200);actor='admin';
  });
  await t.test('módulo desabilitado e tarifas vazias não criam preços oficiais',async()=>{
   assert.equal((await call('/porto/resumo',{resource:new PortoService(db,false)})).status,503);
   assert.deepEqual((await call('/porto/tarifas')).data.tarifas,[]);assert.equal((await request()).data.error.code,'TARIFF_UNAVAILABLE');
   assert.equal((await owner.query('SELECT count(*) AS n FROM porto_solicitacoes')).rows[0].n,'0');
  });
  await t.test('matriz aprovada e proteção de origem também valem para o novo módulo',async()=>{
   actor='reader';assert.equal((await call('/porto/resumo')).status,403);actor='operations';assert.equal((await call('/porto/resumo')).status,403);
   actor='gate';assert.equal((await publish(10000)).status,403);assert.equal((await approve('inexistente')).status,403);
   actor='finance';assert.equal((await request()).status,403);assert.equal((await call('/porto/resumo')).status,200);
   actor='admin';assert.equal((await call('/porto/comandos',{method:'POST',body:{},headers:{origin:'http://outside.invalid'}})).status,403);
  });
  await t.test('solicitação reaproveita cadastro e decisão é auditada uma única vez',async()=>{
   assert.equal((await publish(10000)).status,200);actor='gate';const requested=await request();assert.equal(requested.status,200,JSON.stringify(requested.data));requestId=requested.data.result.id;
   assert.equal((await command('REGISTRAR_ENTRADA',{id:requestId,veiculoConferido:true})).data.error.code,'APPROVAL_REQUIRED');
   actor='director';const key=randomUUID(),payload={id:requestId,justificativa:'Aprovação QA'};
   const responses=await Promise.all([command('APROVAR_DESCIDA',payload,key),command('APROVAR_DESCIDA',payload,key)]);assert.ok(responses.every(value=>value.status===200));assert.equal(responses.filter(value=>value.data.replayed).length,1);
   assert.equal((await command('RECUSAR_DESCIDA',{id:requestId,justificativa:'Outra decisão'})).status,409);
   assert.equal((await owner.query("SELECT count(*) AS n FROM porto_eventos WHERE acao='APROVAR_DESCIDA'")).rows[0].n,'1');
  });
  await t.test('entrada usa horário do servidor e preço vigente na entrada',async()=>{
   actor='admin';assert.equal((await publish(15000)).status,200);actor='gate';
   assert.equal((await command('REGISTRAR_ENTRADA',{id:requestId})).data.error.code,'IDENTITY_REQUIRED');
   const key=randomUUID(),payload={id:requestId,veiculoConferido:true,entradaEm:'2001-01-01T00:00:00Z'},before=Date.now(),entered=await command('REGISTRAR_ENTRADA',payload,key);assert.equal(entered.status,200,JSON.stringify(entered.data));stayId=entered.data.result.id;
   assert.ok(Date.parse(entered.data.result.entradaEm)>=before-1000);assert.equal('valorDiariaCentavos' in entered.data.result,false);
   assert.equal((await command('REGISTRAR_ENTRADA',payload,key)).data.replayed,true);
   assert.equal((await command('REGISTRAR_ENTRADA',{...payload,veiculoConferido:false},key)).status,409);
   actor='admin';const state=(await call('/porto/permanencias')).data;assert.equal(state.rows[0].valorDiariaCentavos,15000);assert.equal(state.rows[0].previa.totalCentavos,15000);
   await publish(30000);assert.equal((await call('/porto/permanencias')).data.rows[0].previa.valorDiariaCentavos,15000);
   assert.equal((await owner.query("SELECT count(*) AS n FROM operational_records WHERE collection IN ('vehicles','visitors','stays','charges')")).rows[0].n,'0');
  });
  await t.test('duas solicitações aprovadas não permitem duas permanências abertas',async()=>{
   const other=await request();assert.equal(other.status,200);await approve(other.data.result.id);
   const responses=await Promise.all([command('REGISTRAR_ENTRADA',{id:other.data.result.id,veiculoConferido:true}),command('REGISTRAR_ENTRADA',{id:other.data.result.id,veiculoConferido:true})]);assert.ok(responses.every(value=>value.status===409));
   assert.equal((await owner.query('SELECT count(*) AS n FROM porto_permanencias')).rows[0].n,'1');
   assert.equal((await owner.query("SELECT count(*) AS n FROM porto_eventos WHERE acao='REGISTRAR_ENTRADA'")).rows[0].n,'1');
  });
  await t.test('dados financeiros não vazam para a portaria; auditoria não pode ser reescrita',async()=>{
   actor='gate';for(const path of ['/porto/permanencias','/porto/tarifas','/porto/resumo'])assert.doesNotMatch(JSON.stringify((await call(path)).data),/centavos/i);
   assert.equal((await call('/porto/eventos')).status,403);actor='finance';assert.equal((await call('/porto/permanencias')).data.rows[0].valorDiariaCentavos,15000);
   assert.equal((await call('/porto/eventos')).status,403);actor='admin';assert.ok((await call('/porto/eventos')).data.rows.length>0);
   await assert.rejects(db.pool.query("UPDATE porto_tarifas SET diaria_centavos=1"));await assert.rejects(db.pool.query('DELETE FROM porto_eventos'));
   await assert.rejects(db.pool.query('UPDATE porto_permanencias SET saida_em=clock_timestamp(),status=\'encerrada\',saida_operador_id=\'admin\' WHERE id=$1',[stayId]));
   assert.equal((await command('REGISTRAR_SAIDA',{id:stayId,veiculoConferido:true,justificativa:'Tentativa sem empresa pagadora e sem quitação'})).data.error.code,'PAYER_REQUIRED');
  });
  await t.test('sessão revogada é revalidada dentro da transação; restore JSON não apaga o Porto',async()=>{
   actor='admin';const requestToRestore=(await call('/backup')).data,snapshot=(await call('/state')).data;
   const response=await call('/restore',{method:'POST',body:{backup:requestToRestore,revision:snapshot.revision,reason:'Teste da barreira de restauração',idempotencyKey:randomUUID()}});assert.equal(response.status,409,JSON.stringify(response.data));assert.equal(response.data.error.code,'PORTO_FULL_RESTORE_REQUIRED');
   assert.equal((await owner.query('SELECT count(*) AS n FROM porto_permanencias')).rows[0].n,'1');
   const scopedContext={user:{id:'gate',name:'gate',role:'gate',status:'active'},authorize:async database=>{await database.prepare('SELECT 1').first();return {id:'gate',name:'gate',role:'gate',status:'disabled'}}};
   const denied=await porto.handle(new Request(origin+'/api/porto/resumo'),scopedContext);assert.equal(denied.status,403);
   assert.equal((await call('/state')).data.revision,snapshot.revision);
  });
  await t.test('falha de auditoria reverte a entrada; duas entradas novas concorrem com somente uma vencedora',async()=>{
   actor='admin';await owner.query("INSERT INTO operational_records(collection,id,body) VALUES('fleet','car-qa-2',$1)",[JSON.stringify({id:'car-qa-2',plate:'QAT2B34',driver:'QA',active:true,createdAt:now,updatedAt:now,createdBy:'admin'})]);
   const ids=[];for(let n=0;n<2;n++){const created=await command('SOLICITAR_DESCIDA',{veiculoId:'car-qa-2',motoristaNome:'QA',categoriaCodigo:'carro',finalidade:'Teste de concorrência',embarcacaoDestino:'Destino QA'});assert.equal(created.status,200);ids.push(created.data.result.id);assert.equal((await approve(ids[n])).status,200)}
   const rate=(await owner.query("SELECT t.* FROM porto_tarifas t JOIN porto_tabelas_tarifarias v ON v.id=t.tabela_id ORDER BY v.vigencia_inicio DESC LIMIT 1")).rows[0];
   await assert.rejects(db.pool.query("INSERT INTO porto_permanencias(id,unidade_id,solicitacao_id,veiculo_id,placa,motorista_nome,tarifa_id,tabela_tarifaria_id,categoria_codigo,categoria_nome,valor_diaria_centavos,entrada_operador_id) VALUES('bad-snapshot','settings',$1,'car-qa-2','QAT2B34','QA',$2,$3,'carro',$4,1,'admin')",[ids[0],rate.id,rate.tabela_id,rate.categoria_nome]));
   await owner.query("CREATE FUNCTION qa_porto_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.acao='REGISTRAR_ENTRADA' THEN RAISE EXCEPTION 'QA_FAILURE'; END IF; RETURN NEW; END; $$; CREATE TRIGGER qa_porto_failure BEFORE INSERT ON porto_eventos FOR EACH ROW EXECUTE FUNCTION qa_porto_failure()");
   const key=randomUUID(),payload={id:ids[0],veiculoConferido:true};assert.equal((await command('REGISTRAR_ENTRADA',payload,key)).status,500);
   assert.equal((await owner.query("SELECT count(*) AS n FROM porto_permanencias WHERE veiculo_id='car-qa-2'")).rows[0].n,'0');assert.equal((await owner.query('SELECT count(*) AS n FROM porto_comandos WHERE id=$1',[key])).rows[0].n,'0');
   await owner.query('DROP TRIGGER qa_porto_failure ON porto_eventos; DROP FUNCTION qa_porto_failure()');
   const results=await Promise.all([command('REGISTRAR_ENTRADA',payload,key),command('REGISTRAR_ENTRADA',{id:ids[1],veiculoConferido:true})]);assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);
   assert.equal((await owner.query("SELECT count(*) AS n FROM porto_permanencias WHERE veiculo_id='car-qa-2'")).rows[0].n,'1');assert.equal((await owner.query("SELECT count(*) AS n FROM porto_eventos WHERE acao='REGISTRAR_ENTRADA'")).rows[0].n,'2');
  });
  await t.test('backup completo recupera permanências e tarifas e reaplica os privilégios restritos',{skip:!localConfig},async()=>{
   const temporary=await mkdtemp(join(tmpdir(),'portaria-porto-backup-')),restoredDatabase='portaria_recovered_'+token;
   try{
    const adminFile=join(temporary,'qa-admin.json'),mediaRoot=join(temporary,'media');await mkdir(mediaRoot);await writeFile(adminFile,JSON.stringify(adminConfig),{mode:0o600});
    const config={...localConfig,dataRoot:temporary,adminFile,mediaRoot,database:{...adminConfig,database,user:role,password:appPassword}},destination=join(temporary,'backup'),keyFile=join(temporary,'recovery.key');
    const before=await postgresInventory(owner),backup=await createPostgresBackup({config,destination,keyFile,quiesced:true});assert.equal(backup.status,'verified');
    await restorePostgresBackup({config,backupDirectory:destination,keyFile,database:restoredDatabase,mediaRoot:join(temporary,'recovered-media')});
    const restored=new pg.Pool({...adminConfig,database:restoredDatabase});
    try{
     assert.deepEqual(await postgresInventory(restored),before);
     const allowed=(await restored.query("SELECT has_table_privilege($1,'porto_eventos','UPDATE') AS audit_update,has_table_privilege($1,'porto_tarifas','DELETE') AS tariff_delete,has_table_privilege($1,'porto_permanencias','UPDATE') AS stay_update",[role])).rows[0];assert.deepEqual(allowed,{audit_update:false,tariff_delete:false,stay_update:false});
     assert.equal((await restored.query('SELECT count(*) AS n FROM porto_permanencias')).rows[0].n,'2');
     await assert.rejects(restored.query('DELETE FROM porto_eventos'),/PORTO_IMMUTABLE/);
     await assert.rejects(restored.query('SELECT porto_assert_json_restore()'),/PORTO_FULL_RESTORE_REQUIRED/);
    }finally{await restored.end()}
    assert.deepEqual(await postgresInventory(owner),before);
   }finally{
    await control.query(`DROP DATABASE IF EXISTS "${restoredDatabase}" WITH (FORCE)`);
    if(!resolve(temporary).startsWith(resolve(tmpdir())+sep))throw Error('Pasta de backup QA fora do diretório temporário.');
    await rm(temporary,{recursive:true,force:true});
   }
  });
 });
});
