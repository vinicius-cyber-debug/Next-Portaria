import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../lib/server.ts';
import {testSession} from './fixture-auth.mjs';

/** A API usa as mesmas migrations e transações atômicas D1, sem dados operacionais. */
class D1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');const directory=new URL('../drizzle/',import.meta.url);for(const name of readdirSync(directory).filter(p=>p.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(name,directory),'utf8'));}
  prepare(sql){const owner=this;return {sql,params:[],bind(...params){return {...this,params};},async first(){return owner.sqlite.prepare(this.sql).get(...this.params)??null;},async all(){return {results:owner.sqlite.prepare(this.sql).all(...this.params),success:true};},async run(){const result=owner.sqlite.prepare(this.sql).run(...this.params);return {results:[],success:true,meta:{changes:Number(result.changes)}};}};}
  async batch(statements){this.sqlite.exec('BEGIN');try{const result=statements.map(s=>({results:this.sqlite.prepare(s.sql).all(...s.params),success:true}));this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}
const origin='https://porto.example.test',owner={id:'v5-assigned-owner',name:'Administradora fictícia',email:'v5-assigned-owner@example.test'};
let sequence=0;
async function call(db,path,method='GET',body,user=owner){
  const headers={cookie:testSession(db,user)};if(method!=='GET'){headers.origin=origin;headers['content-type']='application/json';}
  const response=await handleApi(new Request(origin+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),db);
  return {status:response.status,body:await response.json()};
}
async function setup(){const db=new D1();assert.equal((await call(db,'/session')).status,200);return db;}
async function snapshot(db,user=owner){const answer=await call(db,'/state','GET',undefined,user);assert.equal(answer.status,200,JSON.stringify(answer.body));return answer.body;}
async function command(db,type,payload,user=owner,idempotencyKey=`assigned-v5-command-${++sequence}`){return call(db,'/commands','POST',{type,payload,idempotencyKey,revision:(await snapshot(db,user)).revision},user);}
async function ok(db,type,payload,user=owner,key){const result=await command(db,type,payload,user,key);assert.equal(result.status,200,`${type}: ${JSON.stringify(result.body)}`);return result.body.result;}
async function reject(db,type,payload,code,user=owner){const before=(await snapshot(db)).revision,result=await command(db,type,payload,user);assert.notEqual(result.status,200,JSON.stringify(result.body));assert.equal(result.body.error.code,code);assert.equal((await snapshot(db)).revision,before);return result;}
async function member(db,role){const id=`assigned-v5-${role}-${++sequence}`,user={id,name:`Pessoa ${role} ${sequence}`,email:id+'@example.test'};assert.equal((await call(db,'/users','POST',{action:'invite',...user,role,idempotencyKey:`assigned-v5-invite-${++sequence}`})).status,200);assert.equal((await call(db,'/session','GET',undefined,user)).body.user.role,role);return user;}
async function grant(db,user,overrides){const result=await call(db,'/access','POST',{userId:user.id,overrides,reason:'Verificação de permissões fictícia',revision:(await snapshot(db)).revision,idempotencyKey:`assigned-v5-capability-${++sequence}`});assert.equal(result.status,200,JSON.stringify(result.body));}
async function area(db,fields={}){return ok(db,'ACCESS_AREA_SAVE',{name:`Setor fictício ${++sequence}`,active:true,restricted:false,...fields});}
function visitPayload(fields={}){return {name:`Visitante fictício ${++sequence}`,company:'Empresa fictícia',purpose:'Verificação de integração',host:'Responsável fictício',expectedAt:new Date(Date.now()-3600000).toISOString(),validUntil:new Date(Date.now()+7200000).toISOString(),...fields};}
async function visit(db,fields={},user=owner){return ok(db,'VISITOR_REQUEST',visitPayload(fields),user);}
async function issue(db,visitorId){const result=await call(db,'/passes/issue','POST',{visitorId,revision:(await snapshot(db)).revision,idempotencyKey:`assigned-v5-pass-${++sequence}`});assert.equal(result.status,200,JSON.stringify(result.body));return result.body.pass.code;}
function requirement(personId,fields={}){return {personId,name:'Integração da unidade',status:'approved',validUntil:new Date(Date.now()+86400000).toISOString(),areaIds:[],notes:'Conferência de documentação fictícia',...fields};}
async function assignedFixture(){const db=await setup(),responsible=await member(db,'director'),substitute=await member(db,'director'),other=await member(db,'director'),gate=await member(db,'gate'),sector=await area(db,{responsibleUserId:responsible.id,substituteUserId:substitute.id});return {db,responsible,substitute,other,gate,sector};}

test('API aceita responsáveis reais e ativos com perfil aprovador, rejeitando outras referências',async()=>{
  const f=await assignedFixture(),{db,responsible,substitute,gate}=f,reader=await member(db,'reader');
  const approvers=(await call(db,'/approvers','GET',undefined,gate)).body.users;
  assert.ok(approvers.some(user=>user.id===owner.id));assert.ok(approvers.some(user=>user.id===responsible.id));assert.ok(approvers.some(user=>user.id===substitute.id));
  assert.equal(approvers.some(user=>[gate.id,reader.id].includes(user.id)),false);
  for(const responsibleUserId of ['nonexistent-user',gate.id,reader.id])await reject(db,'ACCESS_AREA_SAVE',{name:`Setor inválido ${++sequence}`,responsibleUserId},'INVALID_APPROVER');
  await reject(db,'ACCESS_AREA_SAVE',{name:'Substituto sem responsável',substituteUserId:substitute.id},'VALIDATION');
  await reject(db,'ACCESS_AREA_SAVE',{name:'Duplicado',responsibleUserId:responsible.id,substituteUserId:responsible.id},'VALIDATION');
  assert.equal((await call(db,'/users','POST',{action:'update',id:responsible.id,role:'director',status:'disabled',idempotencyKey:`assigned-v5-disable-${++sequence}`})).status,200);
  await reject(db,'VISITOR_REQUEST',visitPayload({areaId:f.sector.id}),'INVALID_APPROVER',gate);
  assert.equal((await call(db,'/approvers','GET',undefined,gate)).body.users.some(user=>user.id===responsible.id),false);
});

test('visita usa responsáveis do setor e decisões conferem identidade real, incluindo substituto',async()=>{
  const {db,responsible,substitute,other,gate,sector}=await assignedFixture(),v=await visit(db,{areaId:sector.id},gate);
  assert.equal(v.responsibleUserId,responsible.id);assert.equal(v.substituteUserId,substitute.id);
  await reject(db,'VISITOR_APPROVE',{id:v.id,actorId:responsible.id},'ASSIGNED_APPROVER_REQUIRED',other);
  await reject(db,'VISITOR_REJECT',{id:v.id,reason:'Teste fictício'},'ASSIGNED_APPROVER_REQUIRED',other);
  assert.equal((await ok(db,'VISITOR_APPROVE',{id:v.id},substitute)).status,'authorized');
  await reject(db,'VISITOR_REVOKE',{id:v.id,reason:'Teste fictício'},'ASSIGNED_APPROVER_REQUIRED',other);
  assert.equal((await ok(db,'VISITOR_REVOKE',{id:v.id,reason:'Responsável cancelou'},responsible)).status,'revoked');
  const denied=await visit(db,{areaId:sector.id},gate);assert.equal((await ok(db,'VISITOR_REJECT',{id:denied.id,reason:'Substituto recusou'},substitute)).status,'denied');
  const elevated=await visit(db,{areaId:sector.id},gate);assert.equal((await ok(db,'VISITOR_APPROVE',{id:elevated.id})).status,'authorized');
});

test('portaria e gestor sem accessManage não desviam aprovação por campo explícito ou destino indireto',async()=>{
  const {db,responsible,other,gate,sector}=await assignedFixture(),second=await area(db,{responsibleUserId:other.id}),v=await visit(db,{areaId:sector.id},gate);
  for(const fields of [{responsibleUserId:other.id},{substituteUserId:null},{responsibleUserId:null,substituteUserId:null}])await reject(db,'VISITOR_REQUEST',visitPayload({areaId:sector.id,...fields}),'FORBIDDEN',gate);
  await reject(db,'RECORD_CORRECT',{kind:'visitor',id:v.id,reason:'Desviar decisão',changes:{areaId:second.id}},'FORBIDDEN',gate);
  await grant(db,gate,{accessManage:true});await reject(db,'VISITOR_REQUEST',visitPayload({areaId:sector.id,responsibleUserId:other.id}),'FORBIDDEN',gate);
  await grant(db,responsible,{accessManage:false});
  await reject(db,'VISITOR_REQUEST',visitPayload({areaId:sector.id,responsibleUserId:other.id}),'FORBIDDEN',responsible);
  await reject(db,'RECORD_CORRECT',{kind:'visitor',id:v.id,reason:'Desviar decisão pelo destino',changes:{areaId:second.id}},'FORBIDDEN',responsible);
  const annotation=await ok(db,'RECORD_CORRECT',{kind:'visitor',id:v.id,reason:'Acompanhamento operacional',changes:{notes:'Contato efetuado'}},responsible);assert.equal(annotation.responsibleUserId,responsible.id);
});

test('troca autorizada de responsável reinicia aprovação, invalida QR e direciona os avisos',async()=>{
  const {db,responsible,substitute,other,gate,sector}=await assignedFixture(),v=await visit(db,{areaId:sector.id},gate);
  for(const user of [owner,responsible,substitute,gate])assert.ok((await call(db,'/notifications','GET',undefined,user)).body.notifications.some(notice=>notice.entityId===v.id&&notice.kind==='visitor_pending'));
  assert.equal((await call(db,'/notifications','GET',undefined,other)).body.notifications.some(notice=>notice.entityId===v.id&&notice.kind==='visitor_pending'),false);
  await ok(db,'VISITOR_APPROVE',{id:v.id},responsible);const code=await issue(db,v.id);
  const reassigned=await ok(db,'RECORD_CORRECT',{kind:'visitor',id:v.id,reason:'Substituição operacional',changes:{responsibleUserId:other.id,substituteUserId:null}});
  assert.equal(reassigned.status,'pending');assert.equal(reassigned.approvedAt,null);assert.equal((await call(db,'/passes/lookup','POST',{code},gate)).status,404);
  assert.equal((await call(db,'/notifications','GET',undefined,responsible)).body.notifications.some(notice=>notice.entityId===v.id&&notice.kind==='visitor_pending'),false);
  assert.ok((await call(db,'/notifications','GET',undefined,other)).body.notifications.some(notice=>notice.entityId===v.id&&notice.kind==='visitor_pending'));
  await reject(db,'VISITOR_APPROVE',{id:v.id},'ASSIGNED_APPROVER_REQUIRED',responsible);assert.equal((await ok(db,'VISITOR_APPROVE',{id:v.id},other)).status,'authorized');
});

test('API exige gestão de requisitos e fixa o conferente, sem confiar em campos do navegador',async()=>{
  const {db,responsible,gate,sector}=await assignedFixture(),ops=await member(db,'operations'),v=await visit(db,{areaId:sector.id},gate),payload=requirement(v.personId,{status:'pending',validUntil:null,reviewedBy:'Conferente forjado',reviewedByUserId:owner.id,reviewedAt:'2020-01-01T00:00:00Z'});
  await reject(db,'PERSON_REQUIREMENT_SAVE',payload,'FORBIDDEN',gate);
  const saved=await ok(db,'PERSON_REQUIREMENT_SAVE',payload,ops);assert.equal(saved.reviewedByUserId,ops.id);assert.equal(saved.reviewedBy,ops.name);assert.notEqual(saved.reviewedAt,payload.reviewedAt);
  await reject(db,'VISITOR_APPROVE',{id:v.id},'REQUIREMENT_PENDING',responsible);
  await grant(db,ops,{accessManage:false});await reject(db,'PERSON_REQUIREMENT_SAVE',{id:saved.id,status:'approved',validUntil:new Date(Date.now()+86400000).toISOString()},'FORBIDDEN',ops);
  await ok(db,'PERSON_REQUIREMENT_SAVE',{id:saved.id,status:'approved',validUntil:new Date(Date.now()+86400000).toISOString()});assert.equal((await ok(db,'VISITOR_APPROVE',{id:v.id},responsible)).status,'authorized');
});

test('requisito vencido bloqueia entrada, emissão e leitura QR, mas permite restaurar histórico legítimo',async t=>{
  const base=Date.now();t.mock.timers.enable({apis:['Date'],now:base});
  const {db,responsible,gate,sector}=await assignedFixture(),ops=await member(db,'operations'),v=await visit(db,{areaId:sector.id},gate);
  const saved=await ok(db,'PERSON_REQUIREMENT_SAVE',requirement(v.personId,{validUntil:new Date(base+300000).toISOString()}),ops);await ok(db,'VISITOR_APPROVE',{id:v.id},responsible);const code=await issue(db,v.id);
  t.mock.timers.setTime(base+360000);
  await reject(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true},'REQUIREMENT_EXPIRED',gate);
  const lookup=await call(db,'/passes/lookup','POST',{code},gate);assert.equal(lookup.body.error.code,'REQUIREMENT_EXPIRED');
  const issuance=await call(db,'/passes/issue','POST',{visitorId:v.id,revision:(await snapshot(db)).revision,idempotencyKey:`assigned-v5-expired-pass-${++sequence}`});assert.equal(issuance.body.error.code,'REQUIREMENT_EXPIRED');
  await reject(db,'PERSON_REQUIREMENT_SAVE',{id:saved.id,status:'approved',validUntil:new Date(base+359999).toISOString()},'REQUIREMENT_EXPIRED');
  const backup=(await call(db,'/backup')).body;assert.equal(backup.state.personRequirements[0].status,'approved');
  assert.equal((await call(db,'/users','POST',{action:'update',id:ops.id,role:'operations',status:'disabled',idempotencyKey:`assigned-v5-disable-reviewer-${++sequence}`})).status,200);
  const restored=await call(db,'/restore','POST',{backup,reason:'Ensaio isolado de restauração',revision:(await snapshot(db)).revision,idempotencyKey:`assigned-v5-restore-${++sequence}`});assert.equal(restored.status,200,JSON.stringify(restored.body));assert.equal(restored.body.state.personRequirements[0].reviewedByUserId,ops.id);
  await reject(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true},'REQUIREMENT_EXPIRED',gate);
});

test('pendência ou revogação remove QR autorizado, respeita setor e mantém saída de pessoa presente',async()=>{
  const {db,responsible,gate,sector}=await assignedFixture(),otherArea=await area(db),v=await visit(db,{areaId:sector.id},gate);
  const scoped=await ok(db,'PERSON_REQUIREMENT_SAVE',requirement(v.personId,{status:'pending',validUntil:null,areaIds:[otherArea.id]}));await ok(db,'VISITOR_APPROVE',{id:v.id},responsible);const code=await issue(db,v.id);
  const invalidated=await ok(db,'PERSON_REQUIREMENT_SAVE',{id:scoped.id,areaIds:[sector.id],status:'revoked'});assert.equal(invalidated.status,'revoked');assert.equal((await snapshot(db)).state.visitors.find(row=>row.id===v.id).status,'revoked');assert.equal((await call(db,'/passes/lookup','POST',{code},gate)).status,404);
  await ok(db,'PERSON_REQUIREMENT_SAVE',{id:scoped.id,status:'approved',validUntil:new Date(Date.now()+86400000).toISOString()});
  const inside=await visit(db,{areaId:sector.id,personId:v.personId},gate);await ok(db,'VISITOR_APPROVE',{id:inside.id},responsible);await ok(db,'VISITOR_CHECKIN',{id:inside.id,identityConfirmed:true},gate);
  await ok(db,'PERSON_REQUIREMENT_SAVE',{id:scoped.id,status:'pending'});assert.equal((await snapshot(db)).state.visitors.find(row=>row.id===inside.id).status,'inside');assert.equal((await ok(db,'VISITOR_CHECKOUT',{id:inside.id},gate)).status,'completed');
});

test('documentView retira observações reservadas de snapshot, página, delta, auditoria e replay',async()=>{
  const db=await setup(),ops=await member(db,'operations'),person=await ok(db,'MASTER_SAVE',{kind:'people',record:{name:'Pessoa fictícia da conferência',company:'Empresa fictícia'}});
  await grant(db,ops,{documentView:false,auditView:true});const before=await snapshot(db,ops),secret='Detalhe reservado da documentação V5 784263';
  const payload=requirement(person.id,{notes:secret}),key=`assigned-v5-private-replay-${++sequence}`,write=await command(db,'PERSON_REQUIREMENT_SAVE',payload,ops,key);assert.equal(write.status,200);assert.equal(write.body.result.notes,undefined);assert.doesNotMatch(JSON.stringify(write.body),new RegExp(secret));
  assert.equal((await snapshot(db)).state.personRequirements[0].notes,secret);
  const restricted=await snapshot(db,ops),page=await call(db,'/records?collection=personRequirements','GET',undefined,ops),audit=await call(db,'/records?collection=audit','GET',undefined,ops);
  const sync=await call(db,`/sync?since=${before.revision}&windowSince=${encodeURIComponent(before.state.historyWindow.since)}`,'GET',undefined,ops);assert.equal(sync.status,200);assert.ok(sync.body.delta);assert.equal(sync.body.reset,undefined);assert.equal(sync.body.delta.collections.personRequirements.upsert[0].notes,undefined);
  const replay=await command(db,'PERSON_REQUIREMENT_SAVE',payload,ops,key);assert.equal(replay.body.replayed,true);assert.equal(replay.body.result.notes,undefined);
  for(const result of [restricted,page.body,audit.body,sync.body,replay.body])assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
});
