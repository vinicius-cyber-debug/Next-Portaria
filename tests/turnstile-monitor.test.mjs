import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {IdSecureMonitor,monitorEvent,monitorTime} from '../lib/integrations/monitor.ts';
import {IntegrationError} from '../lib/integrations/contracts.ts';
import {handleApi} from '../lib/server.ts';
import {testSession} from './fixture-auth.mjs';
const raw={idLog:'9223372036854775807',idDevice:'99',idUser:'101',device:'Catraca fictícia QA',area:'Área informada QA',name:'Pessoa fictícia QA',eventCode:7,eventName:'Acesso autorizado',time:'/Date(1794248373000-0400)/',userCPF:'NAO_PERSISTIR_CPF',cardNumberStr:'NAO_PERSISTIR_CARTAO',info:'NAO_PERSISTIR_INFO',ipCamera:'NAO_PERSISTIR_CAMERA'};
const user={id:'qa',name:'QA',role:'admin',status:'active',capabilities:{documentView:true}};
const request=()=>new Request('https://fixture.example/api/integrations/idsecure/monitor');
class D1{
 constructor(){this.sqlite=new DatabaseSync(':memory:');const dir=new URL('../drizzle/',import.meta.url);for(const n of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(n,dir),'utf8'));}
 prepare(sql){const sqlite=this.sqlite;return {sql,params:[],bind(...params){return {...this,params}},async first(){return sqlite.prepare(this.sql).get(...this.params)??null},async all(){return {success:true,results:sqlite.prepare(this.sql).all(...this.params)}},async run(){return {success:true,results:[],meta:{changes:Number(sqlite.prepare(this.sql).run(...this.params).changes)}}}};}
 async batch(items){this.sqlite.exec('BEGIN');try{const results=items.map(s=>({success:true,results:this.sqlite.prepare(s.sql).all(...s.params)}));this.sqlite.exec('COMMIT');return results;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
}
function fixture(reader={sourceId:'fixture',async readMonitor(){return [raw]}},load){const db=new D1(),monitor=new IdSecureMonitor(db,'unused-private-file',load??(async()=>reader)),context={user,authorize:async()=>user};return {db,monitor,context,async read(){const r=await monitor.handle(request(),context);return r.json();}};}
test('hora ASP.NET usa milissegundos UTC e não aplica o offset uma segunda vez',()=>{
 assert.equal(monitorTime(raw.time),new Date(1794248373000).toISOString());assert.equal(monitorTime('2026-11-01T08:00:00-04:00'),'2026-11-01T12:00:00.000Z');for(const value of ['01/11/2026 08:00','2026-11-01T08:00:00','invalid','/Date(99)/'])assert.throws(()=>monitorTime(value));
});
test('acesso autorizado nunca é apresentado como giro; resposta descarta dados excedentes',()=>{
 const event=monitorEvent(raw);assert.equal(event.id,raw.idLog);assert.equal(event.kind,'authorized');assert.equal(event.passageConfirmed,false);assert.doesNotMatch(JSON.stringify(event),/NAO_PERSISTIR/);
 for(const [code,kind] of [[3,'unidentified'],[6,'denied'],[8,'pending'],[500,'other']])assert.equal(monitorEvent({...raw,eventCode:code}).kind,kind);
 assert.throws(()=>monitorEvent({...raw,idLog:9223372036854775807}));assert.throws(()=>monitorEvent({...raw,eventCode:'not-a-code'}));
});
test('consulta compartilhada agrupa requisições simultâneas e respeita o cache de três segundos',async()=>{
 let calls=0,release;const wait=new Promise(done=>{release=done}),f=fixture({sourceId:'fixture',async readMonitor(){calls++;await wait;return [raw]}});
 try{const pending=Array.from({length:12},()=>f.read());release();const snapshots=await Promise.all(pending);assert.equal(calls,1);assert.ok(snapshots.every(s=>s.status==='connected'));await f.read();assert.equal(calls,1);assert.equal(snapshots[0].events[0].passageConfirmed,false);}finally{f.db.sqlite.close();}
});
test('mapeia foto pela referência mutável de usuário, sem confundir com idDevice de outra pessoa',async()=>{
 const f=fixture();try{
  for(const person of [{id:'person-correct',name:'Nome revisado QA',directory:{sourceId:'fixture',recordId:'101',nativeId:'3'},directoryPhoto:{sha256:'a'.repeat(64)}},{id:'person-wrong',name:'Outra pessoa QA',directory:{sourceId:'fixture',recordId:'777',nativeId:'101'}}])f.db.sqlite.prepare('INSERT INTO operational_records(collection,id,body) VALUES(?,?,?)').run('people',person.id,JSON.stringify(person));
  const snapshot=await f.read();assert.equal(snapshot.events[0].personId,'person-correct');assert.equal(snapshot.events[0].name,'Nome revisado QA');assert.match(snapshot.events[0].photoUrl,/person-correct\/photo/);assert.doesNotMatch(JSON.stringify(snapshot),/sourceUserId|deviceId|NAO_PERSISTIR/);
 }finally{f.db.sqlite.close();}
});
test('falha mantém últimos eventos como antigos, retarda novas tentativas e não expõe exceção',async()=>{
 let calls=0;const f=fixture({sourceId:'fixture',async readMonitor(){if(calls++)throw Error('TOKEN_PRIVADO_NAO_EXPOR');return [raw]}});
 try{const first=await f.read();f.monitor.nextAttempt=0;const stale=await f.read();assert.equal(stale.status,'offline');assert.equal(stale.lastSuccessAt,first.lastSuccessAt);assert.deepEqual(stale.events,first.events);assert.doesNotMatch(JSON.stringify(stale),/TOKEN_PRIVADO/);await f.read();assert.equal(calls,2);}finally{f.db.sqlite.close();}
});
test('credencial recusada aplica espera longa e configuração ausente é explícita',async()=>{
 let calls=0;const f=fixture({sourceId:'fixture',async readMonitor(){calls++;throw new IntegrationError('authentication')}});
 try{assert.equal((await f.read()).status,'authentication');assert.ok(f.monitor.nextAttempt-Date.now()>59000);await f.read();assert.equal(calls,1);}finally{f.db.sqlite.close();}
 const absent=fixture(undefined,async()=>{throw Object.assign(Error('path'),{code:'ENOENT'})});try{assert.equal((await absent.read()).status,'unconfigured');}finally{absent.db.sqlite.close();}
});
test('API exige sessão/permissão; revalida revogação depois da leitura; não grava operações',async()=>{
 const f=fixture(),account={id:'admin',name:'Admin QA',email:'admin@example.test'};
 try{
  const cookie=testSession(f.db,account),call=(token,method='GET')=>handleApi(new Request(request().url,{method,headers:{...(token?{cookie:token}:{}),...(method==='GET'?{}:{origin:'https://fixture.example'})}}),f.db,{monitor:f.monitor});
  assert.equal((await call()).status,401);const before=f.db.sqlite.prepare('SELECT count(*) AS n FROM operational_audit').get().n;
  const result=await call(cookie);assert.equal(result.status,200);assert.match(result.headers.get('cache-control'),/no-store/);assert.equal((await result.json()).events.length,1);assert.equal((await call(cookie,'POST')).status,405);
  const reader=testSession(f.db,{id:'reader',name:'Reader QA',email:'reader@example.test'});f.db.sqlite.prepare("UPDATE operational_users SET status='active' WHERE id='reader'").run();assert.equal((await call(reader)).status,403);
  const denied=await f.monitor.handle(request(),{user,authorize:async()=>({...user,capabilities:{documentView:false}})});assert.equal(denied.status,403);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM operational_commands').get().n,0);assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM operational_records').get().n,0);assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM operational_audit').get().n,before+1);
 }finally{f.db.sqlite.close();}
});
test('janela substitui atualizações, elimina repetição de câmeras e rejeita identidades conflitantes',async()=>{
 const f=fixture();try{await f.read();f.monitor.nextAttempt=0;f.monitor.reader={sourceId:'fixture',async readMonitor(){return [{...raw,eventCode:6,eventName:'Acesso negado'}]}};assert.equal((await f.read()).events[0].kind,'denied');
  f.monitor.nextAttempt=0;f.monitor.reader={sourceId:'fixture',async readMonitor(){return [raw,{...raw,ipCamera:'OUTRA_CAMERA_DESCARTADA'}]}};assert.equal((await f.read()).events.length,1);
  f.monitor.nextAttempt=0;f.monitor.reader={sourceId:'fixture',async readMonitor(){return [raw,{...raw,idUser:'999'}]}};const stale=await f.read();assert.equal(stale.status,'invalid');assert.equal(stale.events[0].kind,'authorized');
 }finally{f.db.sqlite.close();}
});
