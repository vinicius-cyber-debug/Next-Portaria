import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {withPostgresFixture,hasPostgres,waitUntil} from './support/postgres-fixture.mjs';
import {exitFixture} from './support/exit-fixture.mjs';
import {ExitAccessWorker} from '../lib/exit-access/worker.ts';
import {exitPermissions,effectivePermitStatus} from '../lib/exit-access/policy.mjs';
import {createPostgresBackup,restorePostgresBackup,postgresInventory} from '../lib/postgres-backup.mjs';

test('liberação individual: perfis não elevam autoridade por override e expiração é absoluta',()=>{
 for(const role of ['gate','reader','finance'])assert.equal(exitPermissions({role,status:'active',capabilities:{exitApprove:true,gateOperate:true}}).approve,false);
 assert.equal(exitPermissions({role:'director',status:'disabled',capabilities:{exitApprove:true}}).view,false);
 assert.equal(effectivePermitStatus({expires_at:'2026-11-01T12:00:00Z',status:'applied'},'2026-11-08T12:00:00Z'),'expired');
});
test('saída PostgreSQL: setores, autorização, revogação, falhas e reinícios',{skip:!hasPostgres,timeout:120000},async t=>{
 await withPostgresFixture(async fixture=>{
  const f=await exitFixture(fixture),{owner,db,gateway,runtime,cmd,state,leaders,assign,prepare,confirm,grant}=f;
  await t.test('23 setores são organizacionais; vínculos e responsáveis não acionam equipamento',async()=>{
   const s=(await state()).body;assert.equal(s.sectors.length,23);assert.ok(s.sectors.some(row=>row.name==='Recepção'));assert.ok(s.sectors.some(row=>row.name==='Recepção de Pescados'));
   assert.ok(s.sectors.every(row=>!row.leader_id&&!row.substitute_id));
   await leaders();await assign();await leaders('sec_expedicao','other',null);await assign('employee-b','sec_expedicao');
   assert.deepEqual(gateway.calls,[]);assert.equal((await owner.query('SELECT count(*) AS n FROM exit_bindings')).rows[0].n,'0');
   assert.deepEqual((await state('director')).body.people.map(row=>row.id),['employee-a']);assert.deepEqual((await state('other')).body.people.map(row=>row.id),['employee-b']);
   assert.equal((await cmd('SET_LEADERS',{sectorId:'sec_ti',leaderId:'gate',substituteId:null,version:2})).status,400);
   assert.equal((await cmd('SET_LEADERS',{sectorId:'sec_ti',leaderId:'director',substituteId:'director',version:2})).status,400);
   assert.equal((await cmd('ASSIGN_SECTOR',{personId:'employee-a',sectorId:'sec_ti',version:0})).status,409);
  });
  await t.test('sessão, origem e escopo são exigidos; portaria só consulta',async()=>{
   assert.equal((await state('nobody')).status,401);
   for(const actor of ['reader','finance'])assert.equal((await state(actor)).status,403);
   assert.equal((await state('gate')).status,200);
   assert.deepEqual((await state('gate')).body.events,[]);
   assert.equal((await grant('employee-a','gate')).status,403);assert.equal((await grant('employee-a','other')).status,403);
   assert.equal((await cmd('PREPARE_CONTROL',{personId:'employee-a',reason:'Teste QA'},'director')).status,403);
   assert.equal((await cmd('GRANT',{personId:'employee-a',sectorId:'sec_ti',reason:'Teste QA'},'admin',randomUUID(),{origin:'https://hostile.invalid'})).status,403);
   assert.equal((await grant()).body.error.code,'CONTROL_NOT_READY');
  });
  await t.test('preparo é explícito e não habilita concessões antes da homologação',async()=>{
   await prepare();assert.deepEqual(gateway.calls,[['provision','101']]);
   assert.equal((await grant()).status,409);
   assert.equal((await cmd('CONFIRM_CONTROL',{personId:'employee-a',reason:'Ainda sem teste de contingência',entryNormal:true,exitPending:true,offlineDenied:false})).status,400);
   await confirm();
  });
  let permit;
  await t.test('900 segundos no relógio do banco, idempotência concorrente e nenhuma abertura ao conceder',async()=>{
   const key=randomUUID(),before=Date.now(),responses=await Promise.all([grant('employee-a','director',key),grant('employee-a','director',key)]);
   assert.ok(responses.every(row=>row.status===200),JSON.stringify(responses));assert.equal(responses.filter(row=>row.body.replayed).length,1);
   permit=responses[0].body.result;assert.equal(Date.parse(permit.expires_at)-Date.parse(permit.issued_at),900000);assert.ok(Date.parse(permit.issued_at)>=before-1000);
   assert.equal(gateway.calls.filter(row=>row[0]==='authorize').length,0);
   assert.equal((await grant()).status,409);
   assert.equal((await cmd('GRANT',{personId:'employee-a',sectorId:'sec_ti',reason:'Teste QA',expiresAt:'2099-01-01'},'director')).status,400);
   assert.equal((await cmd('GRANT',{personId:'employee-a',sectorId:'sec_ti',reason:'Teste diferente'},'director',key)).status,409);
   await owner.query("INSERT INTO operational_access(user_id,body) VALUES('director','{\"exitApprove\":false}')");
   assert.equal((await grant('employee-a','director',key)).status,403);
   await owner.query("DELETE FROM operational_access WHERE user_id='director'");
  });
  await t.test('identificação correta autoriza somente o evento de saída uma vez; autorização não é giro',async()=>{
   gateway.pending('999');gateway.pending('101',{eventId:'2001',deviceId:'3'});gateway.pending('101',{eventId:'2002',state:'other'});gateway.pending('101',{eventId:'2003',occurredAt:new Date(Date.now()-60000).toISOString()});
   const event=gateway.pending();await runtime.worker.tick();await runtime.worker.tick();
   assert.deepEqual(gateway.calls.filter(row=>row[0]==='authorize'),[['authorize',event.eventId,'101']]);
   const s=(await state('director')).body;assert.equal(s.permits[0].effective_status,'applied');assert.ok(s.events.some(row=>row.action==='DEVICE_AUTHORIZED'&&row.data.passageConfirmed===false));
   assert.ok((await state('other')).body.events.every(row=>row.sector_id==='sec_expedicao'));
  });
  await t.test('revogação pelo substituto é imediata e impede novas autorizações',async()=>{
   assert.equal((await cmd('REVOKE',{id:permit.id,reason:'Retirada antecipada em QA'},'operations')).status,200);
   gateway.pending();await runtime.worker.tick();assert.equal(gateway.calls.filter(row=>row[0]==='authorize').length,1);
   assert.equal((await state('director')).body.permits[0].effective_status,'revoked');
  });
  await t.test('falha de conexão não prolonga prazo; resposta ambígua e reinício não repetem comando',async()=>{
   gateway.events=[];const granted=await grant();assert.equal(granted.status,200);permit=granted.body.result;
   gateway.offline=true;gateway.pending();await runtime.worker.tick();assert.equal((await state()).body.integration.healthy,false);assert.equal(gateway.calls.filter(row=>row[0]==='authorize').length,1);
   gateway.offline=false;gateway.ambiguous=true;await runtime.worker.tick();assert.equal(gateway.calls.filter(row=>row[0]==='authorize').length,2);
   gateway.ambiguous=false;const restarted=new ExitAccessWorker(db,gateway),stop=await restarted.start();await waitUntil(async()=>(await owner.query("SELECT status FROM exit_worker_state WHERE id=1")).rows[0]?.status==='ready','Worker não reiniciou');await stop();
   assert.equal(gateway.calls.filter(row=>row[0]==='authorize').length,2);
   assert.equal((await state()).body.permits[0].confirmation_pending,true);
   const pending=gateway.events[0];gateway.events=[{...pending,nativeUserId:'102',state:'authorized'}];await runtime.worker.tick();assert.equal((await state()).body.permits[0].confirmation_pending,true);
   gateway.events=[{...pending,state:'authorized'}];await runtime.worker.tick();assert.equal((await state()).body.permits[0].confirmation_pending,false);
   assert.ok((await state('director')).body.events.some(row=>row.action==='CONFIRMATION_RECEIVED'));
  });
  await t.test('mudança de setor revoga permissão e perda da autoridade é reavaliada antes da catraca',async()=>{
   await assign('employee-a','sec_expedicao');assert.equal((await owner.query('SELECT status FROM exit_permits WHERE id=$1',[permit.id])).rows[0].status,'revoked');
   assert.equal((await grant()).status,403);await assign();gateway.events=[];
   assert.equal((await grant()).status,200);await owner.query("UPDATE operational_users SET status='disabled' WHERE id='director'");gateway.pending();await runtime.worker.tick();assert.equal(gateway.calls.filter(row=>row[0]==='authorize').length,2);
   await owner.query("UPDATE operational_users SET status='active' WHERE id='director'");
  });
  await t.test('expiração após oito dias e recuperação de envio interrompido não abrem nem criam regra semanal',async()=>{
   await cmd('REVOKE',{id:(await state()).body.permits.find(row=>!['revoked','expired'].includes(row.effective_status)).id,reason:'Preparar expiração de QA'});
   const oldId=randomUUID();await owner.query("INSERT INTO exit_permits(id,person_id,sector_id,issued_by,issued_by_name,reason,issued_at,expires_at,status) VALUES($1,'employee-a','sec_ti','director','QA director','Liberação histórica de QA',$2,$2::timestamptz+interval '15 minutes','active')",[oldId,new Date(Date.now()-8*86400000)]);
   await owner.query("INSERT INTO exit_dispatches(source_id,event_id,permit_id,person_id,device_id,status,started_at) VALUES('qa-central','crash-event',$1,'employee-a','2','dispatching',clock_timestamp()-interval '8 days')",[oldId]);
   const restarted=new ExitAccessWorker(db,gateway),stop=await restarted.start();await waitUntil(async()=>(await owner.query('SELECT status FROM exit_permits WHERE id=$1',[oldId])).rows[0]?.status==='expired','Expiração não reconciliada');await stop();
   assert.equal((await owner.query("SELECT status FROM exit_dispatches WHERE event_id='crash-event'")).rows[0].status,'uncertain');assert.equal(gateway.calls.filter(row=>row[0]==='authorize').length,2);
   assert.ok((await state('director')).body.events.some(row=>row.action==='EXPIRED'));
  });
  await t.test('auditoria e prazos são imutáveis no banco; restauração parcial é recusada',async()=>{
   for(const query of ["UPDATE exit_events SET action='changed'","DELETE FROM exit_commands","UPDATE exit_permits SET expires_at=expires_at+interval '7 days'"])
    await assert.rejects(db.pool.query(query),error=>['42501','23514'].includes(error.code));
   await assert.rejects(db.pool.query('SELECT exit_assert_json_restore()'),/EXIT_FULL_RESTORE_REQUIRED/);
  });
  await t.test('backup completo recupera setores, responsáveis, janelas e tentativas sem perder o histórico',{skip:!fixture.localConfig},async()=>{
   const temporary=await mkdtemp(join(tmpdir(),'next-portaria-exit-backup-')),restoredDatabase='exit_recovered_'+fixture.token;
   let restored;
   try{
    const adminFile=join(temporary,'admin.json'),mediaRoot=join(temporary,'media');await mkdir(mediaRoot);await writeFile(adminFile,JSON.stringify(fixture.adminConfig),{mode:0o600});
    const config={...fixture.localConfig,dataRoot:temporary,adminFile,mediaRoot,database:{...fixture.adminConfig,database:fixture.database,user:fixture.role,password:fixture.password}},destination=join(temporary,'backup'),keyFile=join(temporary,'recovery.key');
    const before=await postgresInventory(owner),backup=await createPostgresBackup({config,destination,keyFile,quiesced:true});assert.equal(backup.status,'verified');
    await restorePostgresBackup({config,backupDirectory:destination,keyFile,database:restoredDatabase,mediaRoot:join(temporary,'restored-media')});
    restored=new pg.Pool({...fixture.adminConfig,database:restoredDatabase});assert.deepEqual(await postgresInventory(restored),before);
    const counts=(await restored.query('SELECT (SELECT count(*) FROM exit_events) AS events,(SELECT count(*) FROM exit_permits) AS permits,(SELECT count(*) FROM exit_dispatches) AS dispatches')).rows[0];assert.ok(Number(counts.events)>10);assert.ok(Number(counts.permits)>2);assert.ok(Number(counts.dispatches)>1);
    const rights=(await restored.query("SELECT has_table_privilege($1,'exit_events','UPDATE') AS audit_update,has_table_privilege($1,'exit_commands','DELETE') AS command_delete",[fixture.role])).rows[0];assert.deepEqual(rights,{audit_update:false,command_delete:false});
   }finally{await restored?.end();await fixture.control.query(`DROP DATABASE IF EXISTS "${restoredDatabase}" WITH (FORCE)`);if(!resolve(temporary).startsWith(resolve(tmpdir())+sep))throw Error('Pasta de backup QA fora do diretório temporário.');await rm(temporary,{recursive:true,force:true});}
  });
  await t.test('remoção explícita é reconciliada sem tocar em grupos ou outros funcionários',async()=>{
   assert.equal((await cmd('REMOVE_CONTROL',{personId:'employee-a',reason:'Encerrar ensaio isolado'})).status,200);await runtime.worker.tick();
   assert.equal((await state()).body.people.find(row=>row.id==='employee-a').provisioning_status,'removed');assert.equal(gateway.rules.size,0);
   assert.deepEqual(gateway.calls.at(-1),['remove','101']);
  });
 });
});
