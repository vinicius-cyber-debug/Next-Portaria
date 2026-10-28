import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleContinuity} from '../lib/continuity.ts';
import {createInitialState,execute} from '../lib/domain.mjs';

class LocalD1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');this.sqlite.exec(`
    CREATE TABLE operational_continuity_config(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE operational_backup_runs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE operational_notifications(id TEXT PRIMARY KEY,kind TEXT NOT NULL,entity_id TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE operational_notification_reads(notification_id TEXT NOT NULL,user_id TEXT NOT NULL,read_at TEXT NOT NULL,PRIMARY KEY(notification_id,user_id));
    CREATE TABLE operational_job_locks(id TEXT PRIMARY KEY,lease_until TEXT NOT NULL,token TEXT NOT NULL);
    CREATE TABLE operational_audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE operational_meta(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
    CREATE TABLE operational_users(id TEXT PRIMARY KEY,role TEXT NOT NULL,status TEXT NOT NULL);
    CREATE TABLE operational_mutation_guard(token TEXT PRIMARY KEY,expected_revision INTEGER NOT NULL,actor_id TEXT NOT NULL,actor_role TEXT NOT NULL);
    CREATE TABLE operational_attachments(id TEXT PRIMARY KEY,object_key TEXT NOT NULL,size INTEGER NOT NULL);
    INSERT INTO operational_meta VALUES(1,42);
    INSERT INTO operational_users VALUES('admin','admin','active'),('second-admin','admin','active');
  `);this.sqlite.exec(readFileSync(new URL('../db/guards.sql',import.meta.url),'utf8'));}
  prepare(sql){const owner=this;return {sql,params:[],bind(...params){return {...this,params};},async first(){return owner.sqlite.prepare(this.sql).get(...this.params)??null;},async all(){return {results:owner.sqlite.prepare(this.sql).all(...this.params),success:true};},async run(){const result=owner.sqlite.prepare(this.sql).run(...this.params);return {results:[],success:true,meta:{changes:Number(result.changes)}};}};}
  async batch(statements){this.sqlite.exec('BEGIN');try{const result=statements.map(statement=>({results:this.sqlite.prepare(statement.sql).all(...statement.params),success:true}));this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}
class PrivateBucket {
  objects=new Map();puts=0;deletes=[];fail=false;beforePut=null;beforeGet=null;
  async put(key,contents){this.puts++;if(this.beforePut)await this.beforePut();if(this.fail)throw new Error('R2 temporarily unavailable');this.objects.set(key,String(contents));return {key};}
  async get(key){if(this.beforeGet)await this.beforeGet(key);const value=this.objects.get(key);return value===undefined?null:{size:new TextEncoder().encode(value).byteLength,async text(){return value;}};}
  async head(key){const value=this.objects.get(key);return value===undefined?null:{size:new TextEncoder().encode(value).byteLength};}
  async delete(key){this.deletes.push(key);this.objects.delete(key);}
}
const admin={id:'admin',name:'Administradora QA',role:'admin',status:'active',capabilities:{financialView:true}};
function context(){return {db:new LocalD1(),bucket:new PrivateBucket(),user:admin,state:createInitialState(),revision:42};}
function req(path,method='GET',value){return new Request('https://porto.example.test'+path,{method,headers:method==='GET'?{}:{'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});}
async function call(ctx,path,method='GET',value){const response=await handleContinuity(req(path,method,value),ctx);return {status:response.status,response,body:await response.json()};}
async function config(ctx,changes={}){const current=(await call(ctx,'/api/continuity')).body.config;return call(ctx,'/api/continuity/config','POST',{...current,...changes});}
function backupRows(ctx){return ctx.db.sqlite.prepare('SELECT body FROM operational_backup_runs').all().map(row=>JSON.parse(row.body));}

test('continuidade persiste configuração validada e audita sem alterar a revisão operacional',async()=>{
  const ctx=context();const initial=await call(ctx,'/api/continuity');assert.equal(initial.body.storageAvailable,true);assert.equal(initial.body.config.everyHours,24);
  const saved=await config(ctx,{everyHours:6,retentionDays:45});assert.equal(saved.status,200);assert.equal((await call(ctx,'/api/continuity')).body.config.everyHours,6);
  assert.equal(ctx.db.sqlite.prepare('SELECT revision FROM operational_meta WHERE id=1').get().revision,42);
  const event=JSON.parse(ctx.db.sqlite.prepare('SELECT body FROM operational_audit').get().body);assert.equal(event.action,'CONTINUITY_CONFIG_UPDATE');assert.equal(event.actorId,'admin');
  for(const invalid of [{everyHours:0},{everyHours:1.5},{retentionDays:91},{noticeKinds:['visitor_pending','visitor_pending']},{recipientRoles:['invented']},{notificationsEnabled:true,recipientRoles:[]}])assert.equal((await config(ctx,invalid)).status,400);
  assert.equal((await call({...ctx,user:{...admin,role:'gate'}},'/api/continuity')).status,403);
});

test('backup privado inclui coleções novas, verifica em clone e não altera o estado ou revisão',async()=>{
  const ctx=context();ctx.state.audit=[{id:'audit-kept',at:new Date().toISOString(),action:'EXAMPLE'}];const original=structuredClone(ctx.state);
  const run=await call(ctx,'/api/continuity/run','POST');assert.equal(run.body.backup.status,'ready');assert.equal(ctx.bucket.puts,1);
  const id=run.body.backup.id;const saved=(await call(ctx,'/api/continuity')).body.backups[0];assert.equal(saved.key,undefined);assert.match(saved.sha256,/^[a-f0-9]{64}$/);
  const download=await call(ctx,`/api/continuity/backups/${id}`);assert.match(download.response.headers.get('content-disposition'),/attachment/);assert.deepEqual(download.body.state.audit,[]);
  for(const kind of ['contracts','reservations','incidents','handovers','settlements','accessAreas','crewManifests','emergencyRollCalls','accessCorrections'])assert.deepEqual(download.body.state[kind],[]);
  const verified=await call(ctx,`/api/continuity/backups/${id}/verify`,'POST');assert.equal(verified.status,200);assert.equal(verified.body.verification,'passed');assert.deepEqual(ctx.state,original);
  assert.equal(ctx.db.sqlite.prepare('SELECT revision FROM operational_meta WHERE id=1').get().revision,42);
  const repeated=await call(ctx,'/api/automation/run','POST');assert.equal(repeated.body.backup.status,'already_completed');assert.equal(ctx.bucket.puts,1);
});

test('arquivo adulterado falha hash e registra resultado sem restaurar dados',async()=>{
  const ctx=context();const run=await call(ctx,'/api/continuity/run','POST');const record=backupRows(ctx)[0];ctx.bucket.objects.set(record.key,'{"format":"tampered"}');
  const original=structuredClone(ctx.state),result=await call(ctx,`/api/continuity/backups/${run.body.backup.id}/verify`,'POST');assert.equal(result.status,422);assert.equal(result.body.verification,'failed');assert.deepEqual(ctx.state,original);
  assert.equal(backupRows(ctx)[0].verification,'failed');assert.ok(ctx.db.sqlite.prepare("SELECT body FROM operational_audit WHERE json_extract(body,'$.action')='BACKUP_VERIFY_FAILED'").get());
  assert.equal((await call(ctx,`/api/continuity/backups/${record.id}`)).body.error.code,'BACKUP_HASH_MISMATCH');
});

test('lease atômico evita dois objetos na mesma janela e permite recuperação após interrupção',async()=>{
  const ctx=context();let release,entered;const ready=new Promise(resolve=>{entered=resolve;});const blocker=new Promise(resolve=>{release=resolve;});
  ctx.bucket.beforePut=async()=>{entered();await blocker;};const first=call(ctx,'/api/automation/run','POST');await ready;
  const concurrent=await call(ctx,'/api/continuity/run','POST');assert.equal(concurrent.body.backup.status,'running');assert.equal(ctx.bucket.puts,1);release();assert.equal((await first).body.backup.status,'ready');
  const recovery=context();recovery.bucket.fail=true;const failed=await call(recovery,'/api/automation/run','POST');assert.equal(failed.body.backup.status,'failed');assert.equal(backupRows(recovery)[0].status,'failed');
  assert.equal((await call(recovery,'/api/automation/run','POST')).body.backup.status,'running');assert.equal(recovery.bucket.puts,1);
  recovery.db.sqlite.exec("UPDATE operational_job_locks SET lease_until='2000-01-01T00:00:00.000Z'");recovery.bucket.fail=false;
  assert.equal((await call(recovery,'/api/automation/run','POST')).body.backup.status,'ready');assert.equal(backupRows(recovery)[0].attempts,2);assert.equal(recovery.bucket.objects.size,1);
});

test('falha não apaga o último backup bom; sucesso aplica retenção com rastreabilidade',async()=>{
  const ctx=context(),old={id:'backup_old',createdAt:new Date(Date.now()-45*86400000).toISOString(),status:'ready',key:'backups/old.json',revision:1,attempts:1,trigger:'automation',sha256:'old'};
  ctx.db.sqlite.prepare('INSERT INTO operational_backup_runs VALUES(?,?,?,?)').run(old.id,old.createdAt,old.status,JSON.stringify(old));ctx.bucket.objects.set(old.key,'old');ctx.bucket.fail=true;
  assert.equal((await call(ctx,'/api/automation/run','POST')).body.backup.status,'failed');assert.deepEqual(ctx.bucket.deletes,[]);assert.equal(ctx.bucket.objects.has(old.key),true);
  ctx.bucket.fail=false;ctx.db.sqlite.exec("UPDATE operational_job_locks SET lease_until='2000-01-01T00:00:00.000Z'");const success=await call(ctx,'/api/automation/run','POST');assert.equal(success.body.retention.expired,1);assert.equal(backupRows(ctx).find(item=>item.id===old.id).status,'expired');assert.equal(ctx.bucket.objects.has(old.key),false);
});

test('processo com lease vencida não sobrescreve nem remove o objeto do novo dono',async()=>{
  const ctx=context();let release,entered;const ready=new Promise(resolve=>{entered=resolve;});const blocker=new Promise(resolve=>{release=resolve;});
  ctx.bucket.beforePut=async()=>{entered();await blocker;};const abandoned=call(ctx,'/api/automation/run','POST');await ready;
  ctx.db.sqlite.exec("UPDATE operational_job_locks SET lease_until='2000-01-01T00:00:00.000Z'");ctx.bucket.beforePut=null;
  const recovered=await call(ctx,'/api/automation/run','POST');assert.equal(recovered.body.backup.status,'ready');release();assert.equal((await abandoned).body.backup.status,'lease_lost');
  assert.equal(ctx.bucket.objects.size,1);assert.equal(backupRows(ctx)[0].status,'ready');assert.equal(backupRows(ctx)[0].attempts,2);
  assert.equal((await call(ctx,`/api/continuity/backups/${recovered.body.backup.id}/verify`,'POST')).body.verification,'passed');
});

test('ausência de R2 e backup grande registram falha sem afirmar backup criado',async()=>{
  const noStorage=context();noStorage.bucket=null;assert.equal((await call(noStorage,'/api/continuity')).body.storageAvailable,false);const unavailable=await call(noStorage,'/api/continuity/run','POST');assert.equal(unavailable.body.backup.status,'failed');assert.match(unavailable.body.backup.reason,/Armazenamento/);
  const large=context();large.state.people=Array.from({length:2700},(_,i)=>({id:`person_${i}`,name:`Pessoa QA ${i}`,active:true,updatedAt:new Date().toISOString(),updatedBy:'QA',notes:'x'.repeat(2000)}));
  const result=await call(large,'/api/continuity/run','POST');assert.equal(result.body.backup.status,'failed');assert.match(result.body.backup.reason,/5 MiB/);assert.equal(large.bucket.puts,0);assert.equal(backupRows(large)[0].status,'failed');
});

test('notificações de acesso deduplicam causa, respeitam finalidade e registram leitura individual',async()=>{
  const ctx=context();await config(ctx,{backupEnabled:false});const now=Date.now();
  ctx.state.visitors=[{id:'pending',status:'pending',requestedAt:new Date(now-1000).toISOString(),validUntil:new Date(now+3600000).toISOString(),name:'Não deve aparecer no aviso'},
    {id:'expired',status:'authorized',validUntil:new Date(now-3600000).toISOString()},
    {id:'inside',status:'inside',enteredAt:new Date(now-10*3600000).toISOString(),validUntil:new Date(now+3600000).toISOString()}];
  ctx.state.stays=[{id:'stay',status:'active',start:new Date(now-60*3600000).toISOString(),plannedEnd:null}];
  ctx.state.charges=[{id:'charge',status:'partial',balanceCents:100000,dueAt:new Date(now-86400000).toISOString()}];
  const first=await call(ctx,'/api/automation/run','POST');assert.equal(first.body.notifications.created,3);assert.equal(first.body.notifications.active,3);assert.equal(JSON.stringify(first.body).includes('Não deve'),false);
  assert.equal((await call(ctx,'/api/automation/run','POST')).body.notifications.created,0);assert.equal(ctx.db.sqlite.prepare('SELECT count(*) AS n FROM operational_notifications').get().n,3);
  const gate={...ctx,user:{...admin,id:'gate',role:'gate'}};const gateList=(await call(gate,'/api/notifications')).body;assert.equal(gateList.notifications.length,3);assert.ok(gateList.notifications.some(item=>item.kind==='visitor_pending'));assert.ok(gateList.notifications.every(item=>item.kind!=='charge_overdue'&&item.kind!=='stay_overstay'));assert.equal(JSON.stringify(gateList).includes('Não deve'),false);
  const all=(await call(ctx,'/api/notifications')).body;assert.equal(all.unreadCount,3);assert.ok(all.notifications.every(item=>item.kind!=='charge_overdue'&&item.kind!=='stay_overstay'));const id=all.notifications[0].id;
  const read=await call(ctx,'/api/notifications/read','POST',{id});assert.equal(read.status,200);assert.equal((await call(ctx,'/api/notifications/read','POST',{id})).body.readAt,read.body.readAt);assert.equal((await call(ctx,'/api/notifications')).body.unreadCount,2);
  const anotherAdmin={...ctx,user:{...admin,id:'other-admin'}};assert.equal((await call(anotherAdmin,'/api/notifications')).body.unreadCount,3);
  ctx.state.visitors[0].status='cancelled';await call(ctx,'/api/automation/run','POST');assert.equal((await call(ctx,'/api/notifications')).body.notifications.length,2);
  await config(ctx,{notificationsEnabled:false});assert.equal((await call(ctx,'/api/notifications')).body.notifications.length,0);
});
test('prazo da visita e encerramento da unidade geram avisos que encerram com a saída',async()=>{
  const ctx=context();await config(ctx,{backupEnabled:false,noticeKinds:['visitor_overstay','visitor_after_hours'],recipientRoles:['admin','gate']});
  const now=Date.now(),hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Manaus',hour:'2-digit',hourCycle:'h23'}).format(new Date(now))),clock=h=>`${String(h%24).padStart(2,'0')}:00`;
  ctx.state.settings={...ctx.state.settings,timezone:'America/Manaus',openingTime:clock(hour+1),closingTime:clock(hour+2),visitorOverstayHours:8};
  ctx.state.visitors=[{id:'deadline-shorter-than-threshold',name:'Pessoa fictícia',status:'inside',enteredAt:new Date(now-15*60000).toISOString(),validUntil:new Date(now-60000).toISOString()}];
  const gate={...ctx,user:{...admin,id:'gate',role:'gate',capabilities:{financialView:false}}};const notices=(await call(gate,'/api/notifications')).body.notifications;
  assert.deepEqual(new Set(notices.map(row=>row.kind)),new Set(['visitor_overstay','visitor_after_hours']));assert.ok(notices.every(row=>row.section==='quickgate'));
  assert.equal((await call(gate,'/api/notifications')).body.notifications.length,2);
  ctx.state.visitors[0].status='completed';ctx.state.visitors[0].leftAt=new Date().toISOString();assert.equal((await call(gate,'/api/notifications')).body.notifications.length,0);
  assert.ok(ctx.db.sqlite.prepare('SELECT body FROM operational_notifications').all().every(row=>JSON.parse(row.body).resolvedAt));
});

test('avisos não vazam para perfil fora da audiência nem usuário inativo',async()=>{
  const ctx=context();await config(ctx,{backupEnabled:false});ctx.state.visitors=[{id:'a',status:'pending',requestedAt:new Date().toISOString(),validUntil:new Date(Date.now()+3600000).toISOString()}];await call(ctx,'/api/automation/run','POST');
  const reader={...ctx,user:{...admin,id:'reader',role:'reader'}};assert.deepEqual((await call(reader,'/api/notifications')).body,{notifications:[],unreadCount:0});
  const notice=(await call(ctx,'/api/notifications')).body.notifications[0];assert.equal((await call(reader,'/api/notifications/read','POST',{id:notice.id})).status,404);
  assert.equal((await call({...ctx,user:{...admin,status:'disabled'}},'/api/notifications')).status,403);
  assert.equal(await handleContinuity(req('/api/unrelated'),ctx),null);
});

test('abrir notificações atualiza pendências imediatamente sem executar backup',async()=>{
  const ctx=context();ctx.state.visitors=[{id:'request-now',status:'pending',requestedAt:new Date().toISOString(),validUntil:new Date(Date.now()+3600000).toISOString()}];
  const director={...ctx,user:{...admin,id:'director',role:'director',capabilities:{financialView:false}}};
  const first=await call(director,'/api/notifications');assert.equal(first.body.unreadCount,1);assert.equal(first.body.notifications[0].kind,'visitor_pending');assert.equal(ctx.bucket.puts,0);assert.deepEqual(backupRows(ctx),[]);
  ctx.state.visitors[0].status='authorized';const afterApproval=await call(director,'/api/notifications');assert.equal(afterApproval.body.notifications.length,0);
  assert.ok(JSON.parse(ctx.db.sqlite.prepare('SELECT body FROM operational_notifications').get().body).resolvedAt);
});

test('revogação durante leitura lenta do corpo impede configuração e auditoria de sucesso',async()=>{
  const ctx=context(),value=(await call(ctx,'/api/continuity')).body.config;let unblock,reading;
  const waiting=new Promise(resolve=>{unblock=resolve;}),started=new Promise(resolve=>{reading=resolve;});
  const stream=new ReadableStream({async pull(controller){reading();await waiting;controller.enqueue(new TextEncoder().encode(JSON.stringify({...value,everyHours:6})));controller.close();}});
  const request=new Request('https://porto.example.test/api/continuity/config',{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'});
  const pending=handleContinuity(request,ctx);await started;ctx.db.sqlite.exec("UPDATE operational_users SET status='disabled' WHERE id='admin'");unblock();
  const response=await pending;assert.equal(response.status,403);assert.equal((await response.json()).error.code,'ACCESS_REVOKED');
  assert.equal(ctx.db.sqlite.prepare('SELECT count(*) AS n FROM operational_continuity_config').get().n,0);assert.equal(ctx.db.sqlite.prepare('SELECT count(*) AS n FROM operational_audit').get().n,0);assert.equal(ctx.db.sqlite.prepare('SELECT count(*) AS n FROM operational_mutation_guard').get().n,0);
});

test('run e verify revalidam administrador e verificação longa rejeita revisão concorrente',async()=>{
  const ctx=context();const run=await call(ctx,'/api/continuity/run','POST'),id=run.body.backup.id;
  ctx.db.sqlite.exec("UPDATE operational_users SET status='disabled' WHERE id='admin'");
  assert.equal((await call(ctx,'/api/continuity/run','POST')).body.error.code,'ACCESS_REVOKED');assert.equal((await call(ctx,`/api/continuity/backups/${id}/verify`,'POST')).status,403);
  ctx.db.sqlite.exec("UPDATE operational_users SET status='active' WHERE id='admin'");ctx.bucket.beforeGet=async()=>{ctx.db.sqlite.exec('UPDATE operational_meta SET revision=revision+1 WHERE id=1');};
  const conflict=await call(ctx,`/api/continuity/backups/${id}/verify`,'POST');assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,'REVISION_CONFLICT');assert.equal(backupRows(ctx)[0].verification,undefined);
  assert.equal(ctx.db.sqlite.prepare("SELECT count(*) AS n FROM operational_audit WHERE json_extract(body,'$.action')='BACKUP_VERIFY_OK'").get().n,0);
});

test('verificação exige metadados e objetos dos anexos; disponibilidade não copia as fotos no JSON',async()=>{
  const ctx=context(),now=new Date().toISOString();ctx.state=execute(ctx.state,{type:'INCIDENT_CREATE',at:now,payload:{title:'Ocorrência QA',description:'Verificação de anexo',category:'Manutenção',severity:'low',location:'Cais',responsible:'Equipe QA',attachmentIds:['photo_qa']}},admin).state;
  const run=await call(ctx,'/api/continuity/run','POST'),id=run.body.backup.id;
  const noMetadata=await call(ctx,`/api/continuity/backups/${id}/verify`,'POST');assert.equal(noMetadata.status,422);assert.match(noMetadata.body.error.message,/Anexos indisponíveis: 1 de 1/);
  ctx.db.sqlite.prepare('INSERT INTO operational_attachments VALUES(?,?,?)').run('photo_qa','attachments/photo_qa',5);
  assert.equal((await call(ctx,`/api/continuity/backups/${id}/verify`,'POST')).body.verification,'failed');
  ctx.bucket.objects.set('attachments/photo_qa','wrong-size');assert.equal((await call(ctx,`/api/continuity/backups/${id}/verify`,'POST')).body.verification,'failed');
  ctx.bucket.objects.set('attachments/photo_qa','photo');const present=await call(ctx,`/api/continuity/backups/${id}/verify`,'POST');assert.equal(present.body.verification,'passed');
  const download=await call(ctx,`/api/continuity/backups/${id}`);assert.deepEqual(download.body.state.incidents[0].attachmentIds,['photo_qa']);assert.equal(download.body.state.incidents[0].photo,undefined);
  ctx.bucket.objects.delete('attachments/photo_qa');assert.equal((await call(ctx,`/api/continuity/backups/${id}`)).status,200);
});
