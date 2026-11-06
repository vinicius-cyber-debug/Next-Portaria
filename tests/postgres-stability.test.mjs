import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {hashPassword} from '../lib/local-auth.ts';
import {handleApi} from '../lib/server.ts';
import {MediaService} from '../lib/media.ts';
import {postgresError} from '../lib/persistence/postgres-errors.ts';
import {hasPostgres,withPostgresFixture,waitUntil} from './support/postgres-fixture.mjs';

test('PostgreSQL: serializacao e deadlock reais, rollback, idempotencia e encerramento',{skip:!hasPostgres,timeout:90000},async t=>{
 await withPostgresFixture(async({db,owner,database})=>{
  const origin='http://127.0.0.1:5196';let cookie='';
  async function request(path,body){const response=await handleApi(new Request(origin+'/api'+path,{method:body?'POST':'GET',headers:body?{origin,cookie,'content-type':'application/json'}:{cookie},...(body?{body:JSON.stringify(body)}:{})}),db);return {status:response.status,data:await response.json()};}
  await request('/session');const now=new Date().toISOString(),password=randomBytes(24).toString('hex'),secret=await hashPassword(password);
  await owner.query("INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES('stability_admin','qa@example.test','QA','admin','active',$1,$1)",[now]);
  await owner.query("INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at,must_change_password) VALUES('stability_admin','stability.qa',$1,$2,$3,$4,0)",[secret.salt,secret.hash,secret.iterations,now]);
  const login=await handleApi(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'stability.qa',password})}),db);assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
  const snapshot=async()=>({revision:Number((await owner.query('SELECT revision FROM operational_meta WHERE id=1')).rows[0].revision),audit:Number((await owner.query('SELECT count(*) AS n FROM operational_audit')).rows[0].n),commands:Number((await owner.query('SELECT count(*) AS n FROM operational_commands')).rows[0].n)});
  const command=(name,revision,key=randomUUID())=>request('/commands',{type:'MASTER_SAVE',payload:{kind:'companies',record:{name}},revision,idempotencyKey:key});

  await t.test('vinte pares concorrentes retornam 200/409 com uma revisao e uma auditoria por par',async()=>{
   for(let iteration=0;iteration<20;iteration++){
    const before=await snapshot(),names=[`QA ${iteration} A`,`QA ${iteration} B`],results=await Promise.all(names.map(name=>command(name,before.revision)));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409],JSON.stringify(results.map(r=>({status:r.status,error:r.data.error}))));
    assert.deepEqual(await snapshot(),{revision:before.revision+1,audit:before.audit+1,commands:before.commands+1});
    const loser=names[results.findIndex(r=>r.status===409)];assert.equal((await owner.query("SELECT count(*) AS n FROM operational_records WHERE collection='companies' AND body::jsonb->>'name'=$1",[loser])).rows[0].n,'0');
    assert.equal((await owner.query('SELECT count(*) AS n FROM operational_mutation_guard')).rows[0].n,'0');
   }
  });
  await t.test('repeticao concorrente e apos reconexao conserva resultado, revisao e auditoria',async()=>{
   const before=await snapshot(),key=randomUUID(),name='Empresa idempotente';
   const parallel=await Promise.all([command(name,before.revision,key),command(name,before.revision,key)]);assert.ok(parallel.every(r=>[200,409].includes(r.status)));assert.ok(parallel.some(r=>r.status===200));
   const clients=await Promise.all(Array.from({length:db.pool.totalCount},()=>db.pool.connect()));for(const client of clients)client.release(true);assert.equal(db.pool.totalCount,0);
   const replay=await command(name,before.revision,key);assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);
   assert.deepEqual(await snapshot(),{revision:before.revision+1,audit:before.audit+1,commands:before.commands+1});
   assert.equal((await command('Conteudo diferente',before.revision,key)).data.error.code,'IDEMPOTENCY_CONFLICT');
   assert.equal((await owner.query("SELECT count(*) AS n FROM operational_records WHERE collection='companies' AND body::jsonb->>'name'=$1",[name])).rows[0].n,'1');
  });
  await owner.query('CREATE TABLE qa_transaction_rows(id integer PRIMARY KEY,n integer NOT NULL); INSERT INTO qa_transaction_rows VALUES(1,0),(2,0)');
  async function conflict(kind){
   await owner.query('UPDATE qa_transaction_rows SET n=0');
   const first=await owner.connect(),marker='stability_'+randomUUID().replaceAll('-',''),auditId='audit_'+marker,settingId='setting_'+marker;
   let pending,other,coordinator,gateHeld=false;const gate=randomBytes(4).readUInt32BE();
   try{
    await first.query('BEGIN');if(kind==='40P01'){await first.query("SET LOCAL deadlock_timeout='60s'");coordinator=await owner.connect();await coordinator.query('SELECT pg_advisory_lock($1::bigint)',[gate]);gateHeld=true;}await first.query('UPDATE qa_transaction_rows SET n=n+1 WHERE id=1');
    const statements=[db.prepare('INSERT INTO operational_settings(id,body) VALUES(?,?)').bind(settingId,'{}'),db.prepare('INSERT INTO operational_audit(id,at,body) VALUES(?,?,?)').bind(auditId,now,JSON.stringify({id:auditId,at:now,action:'QA_ATOMICITY'}))];
    if(kind==='40P01')statements.push(db.prepare('UPDATE qa_transaction_rows SET n=n+1 WHERE id=2'),db.prepare(`SELECT pg_advisory_xact_lock(?::bigint) /* gate_${marker} */`).bind(gate));
    statements.push(db.prepare(`UPDATE qa_transaction_rows SET n=n+1 WHERE id=1 /* ${marker} */`));
    pending=db.batch(statements).then(value=>({value}),error=>({error}));
    await waitUntil(async()=>Number((await owner.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE $2",[database,'%/* '+(kind==='40P01'?'gate_':'')+marker+' */%'])).rows[0].n)>0,'O segundo escritor nao chegou ao bloqueio.');
    if(kind==='40001')await first.query('COMMIT');
    else{
     other=first.query(`UPDATE qa_transaction_rows SET n=n+1 WHERE id=2 /* owner_${marker} */`).then(()=>({ok:true}),error=>({error}));
     await waitUntil(async()=>Number((await owner.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE $2",[database,'%/* owner_'+marker+' */%'])).rows[0].n)>0,'O primeiro escritor nao chegou ao bloqueio.');
     await coordinator.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);gateHeld=false;
    }
    const result=await pending;assert.equal(result.error?.sqlState,kind);assert.equal(result.error?.code,'REVISION_CONFLICT');
    if(other){assert.equal((await other).ok,true);await first.query('COMMIT');}
    assert.equal((await owner.query('SELECT count(*) AS n FROM operational_settings WHERE id=$1',[settingId])).rows[0].n,'0');
    assert.equal((await owner.query('SELECT count(*) AS n FROM operational_audit WHERE id=$1',[auditId])).rows[0].n,'0');
    assert.deepEqual((await owner.query('SELECT n FROM qa_transaction_rows ORDER BY id')).rows.map(r=>r.n),kind==='40001'?[1,0]:[1,1]);
   }finally{if(gateHeld)await coordinator.query('SELECT pg_advisory_unlock($1::bigint)',[gate]).catch(()=>{});coordinator?.release();await first.query('ROLLBACK').catch(()=>{});first.release();if(pending)await pending;if(other)await other;}
  }
  await t.test('SQLSTATE 40001 real desfaz alteracao parcial e auditoria',()=>conflict('40001'));
  await t.test('SQLSTATE 40P01 real desfaz alteracao parcial e auditoria',()=>conflict('40P01'));
  await t.test('duplicidade em lote preserva classificacao e desfaz operacoes anteriores',async()=>{
   await assert.rejects(db.batch([db.prepare("INSERT INTO operational_settings(id,body) VALUES('qa_duplicate_rollback','{}')"),db.prepare('INSERT INTO qa_transaction_rows(id,n) VALUES(1,9)')]),error=>error.code==='DUPLICATE'&&error.sqlState==='23505');
   assert.equal(await db.prepare("SELECT id FROM operational_settings WHERE id='qa_duplicate_rollback'").first(),null);
  });
  await t.test('conflito dentro da midia atravessa o handler e retorna HTTP 409',async st=>{
   const original=db.transaction.bind(db),media=new MediaService(db,{});let mediaTransactions=0;
   const mocked=st.mock.method(db,'transaction',async(operation,isolation='read committed')=>{if(isolation==='repeatable read')return original(operation,isolation);mediaTransactions++;throw postgresError({code:'40P01',severity:'ERROR'});});
   try{const response=await handleApi(new Request(origin+'/api/media/uploads',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({recordId:'qa_record',name:'teste.mp4',size:1,type:'video/mp4'})}),db,{media});assert.equal(response.status,409);assert.equal((await response.json()).error.code,'REVISION_CONFLICT');assert.equal(mediaTransactions,1);}finally{mocked.mock.restore();}
  });
  await t.test('conexao delimitada nao pode ser reutilizada depois do commit nem do rollback',async()=>{
   let stale;
   await db.transaction(async(_client,scoped)=>{stale=scoped.prepare('SELECT 1');assert.ok(await stale.first());});
   await assert.rejects(stale.first(),/transação ativa/);
   await assert.rejects(db.transaction(async(_client,scoped)=>{stale=scoped.prepare('SELECT 1');throw Error('rollback QA');}));await assert.rejects(stale.first(),/transação ativa/);
   assert.equal(db.pool.waitingCount,0);assert.equal(db.pool.totalCount,db.pool.idleCount);
  });
 });
});
