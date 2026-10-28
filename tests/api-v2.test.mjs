import {testSession} from './fixture-auth.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../lib/server.ts';

/** Adaptador usa SQLite real e as mesmas migrations/triggers; D1 batch tem semântica transacional. */
class LocalD1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');const directory=new URL('../drizzle/',import.meta.url);for(const path of readdirSync(directory).filter(p=>p.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(path,directory),'utf8'));this.sqlite.exec(readFileSync(new URL('../db/guards.sql',import.meta.url),'utf8'));}
  prepare(sql){const owner=this;return {sql,params:[],bind(...params){return {...this,params};},async first(){return owner.sqlite.prepare(this.sql).get(...this.params)??null;},async all(){return {results:owner.sqlite.prepare(this.sql).all(...this.params),success:true};},async run(){const result=owner.sqlite.prepare(this.sql).run(...this.params);return {results:[],success:true,meta:{changes:Number(result.changes)}};}};}
  async batch(statements){if(this.beforeBatch){const hook=this.beforeBatch;this.beforeBatch=null;await hook(statements);}this.sqlite.exec('BEGIN');try{const result=statements.map(statement=>({results:this.sqlite.prepare(statement.sql).all(...statement.params),success:true}));this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}
const origin='https://porto.example.test';
const owner={id:'owner',email:'owner@example.test',name:'Administradora'};
function req(path,method='GET',body=undefined,extra={},cookie=''){
  const headers={...extra};if(cookie)headers.cookie=cookie;
  if(method!=='GET'){headers.origin??=origin;headers['content-type']??='application/json';}
  return new Request(origin+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}
async function call(db,path,method='GET',body=undefined,user=owner,extra={}){const cookie=testSession(db,user);const response=await handleApi(req(path,method,body,extra,cookie),db);return {status:response.status,body:await response.json(),response};}
async function setup(){const db=new LocalD1();const session=await call(db,'/session');assert.equal(session.status,200);const state=await call(db,'/state');return {db,revision:state.body.revision};}
let key=0;
async function command(db,type,payload,revision,idempotencyKey=`operation-${++key}`,user=owner){return call(db,'/commands','POST',{type,payload,revision,idempotencyKey},user);}

test('identidade autenticada é obrigatória e sessão privada não é cacheável',async()=>{
  const db=new LocalD1();const missing=await call(db,'/session','GET',undefined,null);assert.equal(missing.status,401);
  const result=await call(db,'/session');assert.equal(result.body.user.role,'admin');assert.equal(result.body.user.status,'active');assert.match(result.response.headers.get('cache-control'),/no-store/);
});
test('usuário autenticado com acesso pendente não consulta dados',async()=>{
  const {db}=await setup();const second={id:'second',email:'second@example.test',name:'Segundo'};
  const session=await call(db,'/session','GET',undefined,second);assert.equal(session.body.user.status,'pending');assert.equal(session.body.user.role,'reader');
  assert.equal((await call(db,'/state','GET',undefined,second)).status,403);
  assert.equal((await call(db,'/users','GET',undefined,second)).status,403);
});
test('identidade local preserva nomes acentuados',async()=>{
  const db=new LocalD1();const encoded={...owner,name:'Jo%C3%A3o%20da%20Silva'};const result=await call(db,'/session','GET',undefined,encoded,{'x-authenticated-user-full-name-encoding':'percent-encoded-utf-8'});assert.equal(result.body.user.name,'João da Silva');
});
test('perfil autorizado não pode ser elevado pelo corpo da requisição',async()=>{
  const {db}=await setup();const invite=await call(db,'/users','POST',{action:'invite',email:' GATE@EXAMPLE.TEST ',name:'Portaria',role:'gate'});assert.equal(invite.status,200);
  const gate={id:'gate',email:'gate@example.test',name:'Porteiro'};const session=await call(db,'/session','GET',undefined,gate);assert.equal(session.body.user.role,'gate');assert.equal(session.body.user.status,'active');
  const current=await call(db,'/state','GET',undefined,gate);
  const denied=await call(db,'/commands','POST',{type:'SETTINGS_UPDATE',payload:{unitName:'Alteração indevida'},revision:current.body.revision,idempotencyKey:'forged-admin-1',actor:{role:'admin'},role:'admin'},gate);assert.equal(denied.status,403);
  const users=await call(db,'/users');assert.equal(users.body.invites[0].status,'accepted');
});
test('último administrador não pode se desativar nem rebaixar',async()=>{
  const {db}=await setup();for(const values of [{role:'reader',status:'active'},{role:'admin',status:'disabled'}]){const result=await call(db,'/users','POST',{action:'update',id:owner.id,...values});assert.equal(result.status,409);assert.equal(result.body.error.code,'LAST_ADMIN');}
  const session=await call(db,'/session');assert.equal(session.body.user.role,'admin');assert.equal(session.body.user.status,'active');
});
test('origem externa e JSON grande são bloqueados antes da operação',async()=>{
  const {db,revision}=await setup();const external=await call(db,'/commands','POST',{type:'MASTER_SAVE',payload:{kind:'companies',record:{name:'A'}},revision,idempotencyKey:'external-1'},owner,{origin:'https://evil.test'});assert.equal(external.status,403);assert.equal(external.body.error.code,'CSRF');
  const large=await command(db,'MASTER_SAVE',{kind:'companies',record:{name:'x'.repeat(70000)}},revision);assert.equal(large.status,413);
});
test('CAS impede revisão antiga; repetição retorna resultado anterior sem duplicar',async()=>{
  const {db,revision}=await setup();const first=await command(db,'MASTER_SAVE',{kind:'companies',record:{name:'A'}},revision,'same-key-01');assert.equal(first.status,200);assert.equal(first.body.revision,revision+1);
  const duplicate=await command(db,'MASTER_SAVE',{kind:'companies',record:{name:'A'}},revision,'same-key-01');assert.equal(duplicate.status,200);assert.equal(duplicate.body.replayed,true);assert.equal(duplicate.body.state.companies.length,1);
  const stale=await command(db,'MASTER_SAVE',{kind:'companies',record:{name:'B'}},revision,'other-key-02');assert.equal(stale.status,409);
  const changed=await command(db,'MASTER_SAVE',{kind:'companies',record:{name:'C'}},first.body.revision,'same-key-01');assert.equal(changed.status,409);assert.equal(changed.body.error.code,'IDEMPOTENCY_CONFLICT');
});
test('relógio e ator são fixados pelo servidor',async()=>{
  const {db,revision}=await setup();const result=await call(db,'/commands','POST',{type:'MASTER_SAVE',payload:{kind:'companies',record:{name:'Empresa'}},revision,idempotencyKey:'clock-server-1',at:'2000-01-01T00:00:00Z',actor:{name:'Intruso',role:'admin'}});
  assert.equal(result.status,200);assert.equal(result.body.state.audit[0].actor,owner.name);assert.notEqual(result.body.state.audit[0].at,'2000-01-01T00:00:00Z');
});
test('auditoria é imutável no próprio banco',async()=>{
  const {db}=await setup();assert.throws(()=>db.sqlite.exec("UPDATE operational_audit SET body='{}'"),/AUDIT_IMMUTABLE/);assert.throws(()=>db.sqlite.exec('DELETE FROM operational_audit'),/AUDIT_IMMUTABLE/);
});
test('backup operacional não transporta auditoria; evidência tem exportação separada e restrita',async()=>{
  const {db}=await setup();
  const backup=await call(db,'/backup');
  assert.equal(backup.body.auditIncluded,false);
  assert.deepEqual(backup.body.state.audit,[]);
  const archive=await call(db,'/audit-export');
  assert.equal(archive.status,200);
  assert.equal(archive.body.format,'porto-gestao-audit');
  assert.ok(archive.body.audit.length>0);
  const pending={id:'audit-reader',email:'audit-reader@example.test',name:'Consulta'};
  assert.equal((await call(db,'/audit-export','GET',undefined,pending)).status,403);
});
test('restauração preserva auditoria anterior e rejeita backup adulterado',async()=>{
  const {db,revision}=await setup();const created=await command(db,'MASTER_SAVE',{kind:'companies',record:{name:'A'}},revision);const backup=await call(db,'/backup');assert.equal(backup.status,200);
  const changed=await command(db,'MASTER_SAVE',{kind:'companies',record:{name:'B'}},created.body.revision);const originalAuditIds=changed.body.state.audit.map(e=>e.id);
  const restored=await call(db,'/restore','POST',{revision:changed.body.revision,backup:backup.body,reason:'Teste de recuperação controlado',idempotencyKey:'restore-safe-1'});assert.equal(restored.status,200);assert.deepEqual(restored.body.state.companies.map(row=>row.name),['A']);for(const id of originalAuditIds)assert.ok(restored.body.state.audit.some(e=>e.id===id));assert.equal(restored.body.state.audit[0].action,'BACKUP_RESTORE');
  const forged=structuredClone(backup.body);forged.state.settings.dailyRateCents=-1;const denied=await call(db,'/restore','POST',{revision:restored.body.revision,backup:forged,reason:'Arquivo inválido',idempotencyKey:'restore-bad-01'});assert.ok(denied.status>=400);const state=await call(db,'/state');assert.equal(state.body.revision,restored.body.revision);
});
test('guarda transacional rejeita revisão concorrente mesmo após leitura inicial',async()=>{
  const {db,revision}=await setup();const originalBatch=db.batch.bind(db);let changed=false;
  db.batch=async function(statements){if(!changed&&statements[0]?.sql.includes('INSERT INTO operational_mutation_guard')){changed=true;this.sqlite.exec('UPDATE operational_meta SET revision=revision+1 WHERE id=1');}return originalBatch(statements);};
  const result=await command(db,'MASTER_SAVE',{kind:'companies',record:{name:'Concorrente'}},revision);assert.equal(result.status,409);const state=await call(db,'/state');assert.equal(state.body.state.companies.length,0);
});
test('revogação concorrente de permissão é validada dentro da transação',async()=>{
  const {db}=await setup();await call(db,'/users','POST',{action:'invite',email:'gate@example.test',name:'Portaria',role:'gate'});const gate={id:'gate',email:'gate@example.test',name:'Porteiro'};await call(db,'/session','GET',undefined,gate);const current=await call(db,'/state','GET',undefined,gate);
  const originalBatch=db.batch.bind(db);let changed=false;db.batch=async function(statements){if(!changed&&statements[0]?.sql.includes('INSERT INTO operational_mutation_guard')){changed=true;this.sqlite.exec("UPDATE operational_users SET status='disabled' WHERE id='gate'");}return originalBatch(statements);};
  const result=await command(db,'VEHICLE_ENTER',{plate:'ABC1D23',driver:'João',company:'Empresa',purpose:'Entrega'},current.body.revision,'revocation-001',gate);assert.equal(result.status,403);assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM operational_records WHERE collection='vehicles'").get().n,0);
});
