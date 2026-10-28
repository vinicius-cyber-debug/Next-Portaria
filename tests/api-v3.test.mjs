import {testSession} from './fixture-auth.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../lib/server.ts';

class D1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');const dir=new URL('../drizzle/',import.meta.url);for(const name of readdirSync(dir).filter(p=>p.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(name,dir),'utf8'));}
  prepare(sql){const owner=this;return {sql,params:[],bind(...params){return {...this,params};},async first(){return owner.sqlite.prepare(this.sql).get(...this.params)??null;},async all(){return {results:owner.sqlite.prepare(this.sql).all(...this.params),success:true};},async run(){const r=owner.sqlite.prepare(this.sql).run(...this.params);return {results:[],success:true,meta:{changes:Number(r.changes)}};}};}
  async batch(statements){if(this.hook){const fn=this.hook;this.hook=null;await fn(statements);}this.sqlite.exec('BEGIN');try{const r=statements.map(s=>({results:this.sqlite.prepare(s.sql).all(...s.params),success:true}));this.sqlite.exec('COMMIT');return r;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
}
class Bucket {
  data=new Map();
  async put(key,value){this.data.set(key,typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value));}
  async get(key){const b=this.data.get(key);return b?{size:b.length,body:new Response(b).body,text:async()=>new TextDecoder().decode(b)}:null;}
  async head(key){const b=this.data.get(key);return b?{size:b.length}:null;}
  async delete(key){this.data.delete(key);}
}
const origin='https://porto.example.test',owner={id:'owner',name:'Administradora',email:'owner@example.test'};
let key=0;
function request(path,method='GET',body,user=owner,headers={},cookie=''){
  const h={...headers};if(cookie)h.cookie=cookie;
  if(method!=='GET'){if(user)h.origin??=origin;if(!(body instanceof FormData))h['content-type']??='application/json';}
  return new Request(origin+'/api'+path,{method,headers:h,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
}
async function call(db,path,method='GET',body,user=owner,resources={},headers={}){
  const cookie=testSession(db,user),r=await handleApi(request(path,method,body,user,headers,cookie),db,resources);
  const type=r.headers.get('content-type')??'';return {status:r.status,body:type.includes('json')?await r.json():await r.text(),response:r};
}
async function snapshot(db,user=owner){return (await call(db,'/state','GET',undefined,user)).body;}
async function command(db,type,payload,user=owner,idempotencyKey=`v3-command-${++key}`,rev){const current=rev??(await snapshot(db,user)).revision;return call(db,'/commands','POST',{type,payload,revision:current,idempotencyKey},user);}
async function setup(){const db=new D1();await call(db,'/session');return db;}
async function member(db,role){const user={id:role,email:role+'@example.test',name:role};assert.equal((await call(db,'/users','POST',{action:'invite',...user,role,idempotencyKey:`invite-v3-${++key}`})).status,200);assert.equal((await call(db,'/session','GET',undefined,user)).body.user.role,role);return user;}
async function grant(db,user,overrides){return call(db,'/access','POST',{userId:user.id,overrides,reason:'Configuração de homologação',revision:(await snapshot(db)).revision,idempotencyKey:`access-v3-${++key}`});}
async function visit(db){const now=Date.now(),r=await command(db,'VISITOR_REQUEST',{name:'Pessoa fictícia',company:'Empresa fictícia',purpose:'Homologação',host:'Responsável',expectedAt:new Date(now-3600000).toISOString(),validUntil:new Date(now+7200000).toISOString(),documentLast4:'4321'});assert.equal(r.status,200);const id=r.body.result.id;assert.equal((await command(db,'VISITOR_APPROVE',{id})).status,200);return id;}
async function issue(db,visitorId,user=owner,idempotencyKey=`pass-v3-${++key}`){return call(db,'/passes/issue','POST',{visitorId,revision:(await snapshot(db,user)).revision,idempotencyKey},user);}

test('API remove contatos e documentos conforme permissões, inclusive no replay',async()=>{
  const db=await setup(),ops=await member(db,'operations'),payload={kind:'companies',record:{name:'Empresa fictícia',contact:'Contato reservado',phone:'5592999999999',email:'privado@example.test'}};
  const created=await command(db,'MASTER_SAVE',payload,ops,'private-company-replay');assert.equal(created.status,200);await visit(db);
  await grant(db,ops,{documentView:false,auditView:true});const restricted=await snapshot(db,ops);
  assert.equal(restricted.state.settings.dailyRateCents,undefined);assert.equal(restricted.state.companies[0].contact,undefined);assert.equal(restricted.state.companies[0].email,undefined);assert.equal(restricted.state.visitors[0].documentLast4,undefined);
  for(const collection of ['stays','charges','contracts','settlements'])assert.deepEqual(restricted.state[collection],[]);
  const replay=await command(db,'MASTER_SAVE',payload,ops,'private-company-replay',0);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.body.result.contact,undefined);assert.equal(replay.body.result.email,undefined);
  assert.doesNotMatch(JSON.stringify(restricted.state),/Contato reservado|privado@example.test/);assert.doesNotMatch(JSON.stringify(replay.body.result),/Contato reservado|privado@example.test/);
});test('permissões refinadas restringem mas não ampliam o papel base; alterações são auditadas',async()=>{
  const db=await setup(),gate=await member(db,'gate');const denied=await call(db,'/access','POST',{},gate);assert.equal(denied.status,403);
  const updated=await grant(db,gate,{accessManage:true,gateOperate:false});assert.equal(updated.status,200);
  assert.equal((await command(db,'ACCESS_AREA_SAVE',{record:{name:'Área indevida'}},gate)).status,403);assert.equal((await command(db,'VEHICLE_ENTER',{plate:'ABC1D23',driver:'Motorista',company:'Empresa',purpose:'Teste'},gate)).status,403);
  assert.ok((await snapshot(db)).state.audit.some(e=>e.action==='ACCESS_UPDATE'));
  const self=await grant(db,owner,{accessManage:false});assert.equal(self.status,400);assert.equal((await call(db,'/session')).body.user.capabilities.accessManage,true);
});test('administração rejeita tarifa e criação de perfil financeiro aposentados',async()=>{
  const db=await setup(),before=await snapshot(db);
  const tariff=await command(db,'SETTINGS_UPDATE',{dailyRateCents:1});assert.equal(tariff.status,400);assert.equal(tariff.body.error.code,'MODULE_REMOVED');assert.equal((await snapshot(db)).revision,before.revision);
  const invited=await call(db,'/users','POST',{action:'invite',email:'finance@example.test',name:'Financeiro',role:'finance',idempotencyKey:'retired-finance-invite'});assert.equal(invited.status,400);assert.equal(invited.body.error.code,'MODULE_REMOVED');
});test('permissão de exportação é aplicada no servidor e neutraliza fórmula CSV',async()=>{
  const db=await setup(),reader=await member(db,'reader');assert.equal((await call(db,'/exports?kind=visitors','GET',undefined,reader)).status,403);
  await command(db,'VISITOR_REQUEST',{name:'=HYPERLINK("malicious")',company:'Empresa',purpose:'Teste',host:'Resp.',expectedAt:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+10000).toISOString()});
  await grant(db,reader,{dataExport:true});const csv=await call(db,'/exports?kind=visitors','GET',undefined,reader);assert.equal(csv.status,200);assert.match(csv.body,/'=HYPERLINK/);const retired=await call(db,'/exports?kind=charges','GET',undefined,reader);assert.equal(retired.status,400);assert.equal(retired.body.error.code,'MODULE_REMOVED');
});
test('crachá usa segredo opaco, reemissão substitui código e revogação bloqueia leitura',async()=>{
  const db=await setup(),gate=await member(db,'gate'),id=await visit(db);const first=await issue(db,id);assert.equal(first.status,200);assert.match(first.body.pass.code,/^PGV1\.[a-f0-9]{64}$/);assert.doesNotMatch(first.body.pass.code,/Pessoa|4321/);
  const good=await call(db,'/passes/lookup','POST',{code:first.body.pass.code},gate);assert.equal(good.status,200);assert.equal(good.body.visitor.id,id);
  assert.equal(db.sqlite.prepare('SELECT token_hash FROM operational_passes').get().token_hash.includes(first.body.pass.code),false);
  const second=await issue(db,id);assert.notEqual(second.body.pass.code,first.body.pass.code);assert.equal((await call(db,'/passes/lookup','POST',{code:first.body.pass.code},gate)).status,404);
  await command(db,'VISITOR_REVOKE',{id,reason:'Acesso cancelado para teste'});assert.equal((await call(db,'/passes/lookup','POST',{code:second.body.pass.code},gate)).status,400);
});
test('emissão de passe é idempotente e restauração invalida os crachás antigos',async()=>{
  const db=await setup(),id=await visit(db),backup=(await call(db,'/backup')).body;const first=await issue(db,id,owner,'pass-retry-v3');const again=await issue(db,id,owner,'pass-retry-v3');assert.equal(again.body.pass.code,first.body.pass.code);assert.equal(again.body.replayed,true);
  const restored=await call(db,'/restore','POST',{revision:(await snapshot(db)).revision,backup,reason:'Homologação de restauração',idempotencyKey:'restore-v3-passes'});assert.equal(restored.status,200);assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM operational_passes').get().n,0);
});
test('anexos exigem conteúdo permitido, permissão e armazenamento privado',async()=>{
  const db=await setup(),gate=await member(db,'gate'),bucket=new Bucket();const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1UAAAAASUVORK5CYII=','base64');
  const form=new FormData();form.set('file',new File([png],'evidencia.png',{type:'image/png'}));const upload=await call(db,'/attachments','POST',form,gate,{bucket});assert.equal(upload.status,200);const id=upload.body.attachment.id;
  const get=await call(db,'/attachments/'+id,'GET',undefined,gate,{bucket});assert.equal(get.status,200);assert.match(get.response.headers.get('content-disposition'),/attachment/);assert.match(get.response.headers.get('content-security-policy'),/sandbox/);
  const forged=new FormData();forged.set('file',new File(['<script>alert(1)</script>'],'fake.png',{type:'image/png'}));assert.equal((await call(db,'/attachments','POST',forged,gate,{bucket})).status,400);
  await grant(db,gate,{documentView:false});assert.equal((await call(db,'/attachments/'+id,'GET',undefined,gate,{bucket})).status,403);
  const current=await snapshot(db,gate);assert.equal(current.state.incidents.length,0);assert.equal(current.state.audit.length,0);
});
test('ocorrência rejeita vínculo de anexo inexistente ou de outro autor',async()=>{
  const db=await setup(),gate=await member(db,'gate');const r=await command(db,'INCIDENT_CREATE',{title:'Teste',description:'Teste de evidência',category:'Operação',severity:'low',location:'Portaria',responsible:'Responsável',attachmentIds:['attachment_missing']},gate);assert.equal(r.status,400);assert.equal((await snapshot(db)).state.incidents.length,0);
});
test('serviço automático não aceita identidade ou origem como substituto do token',async()=>{
  const db=await setup(),resources={bucket:new Bucket(),jobToken:'secret-v3-test-token'};
  assert.equal((await call(db,'/automation/run','POST',{},owner,resources)).status,401);
  assert.equal((await call(db,'/automation/run','POST',{},null,resources,{'x-porto-job-token':'wrong'})).status,401);
  const result=await call(db,'/automation/run','POST',{},null,resources,{'x-porto-job-token':resources.jobToken});assert.equal(result.status,200);assert.equal(result.body.backup.status,'ready');assert.equal(result.body.state,undefined);assert.equal(result.body.user,undefined);assert.equal(result.body.notifications.created,0);
  assert.equal((await call(db,'/automation/status','GET',undefined,owner,resources)).status,401);
  const status=await call(db,'/automation/status','GET',undefined,null,resources,{'x-porto-job-token':resources.jobToken});assert.equal(status.body.lastBackup.id,result.body.backup.id);assert.equal(status.body.state,undefined);
  const schedule=await call(db,'/automation/schedule','POST',{scheduleId:'test-schedule-id',enabled:true,timezone:'America/Manaus'},null,resources,{'x-porto-job-token':resources.jobToken});assert.equal(schedule.status,200);assert.equal((await call(db,'/continuity','GET',undefined,owner,resources)).body.automation.enabled,true);
});
test('restauração rejeita backup quando o arquivo vinculado não está disponível',async()=>{
  const db=await setup(),bucket=new Bucket(),form=new FormData(),resources={bucket};form.set('file',new File([Buffer.from('%PDF-1.4\nQA fictício')],'teste.pdf',{type:'application/pdf'}));
  const upload=await call(db,'/attachments','POST',form,owner,resources);assert.equal(upload.status,200);
  const incident=await command(db,'INCIDENT_CREATE',{title:'Ocorrência fictícia',description:'Teste do vínculo de arquivo',category:'Operação',severity:'low',location:'Portaria',responsible:'Responsável',attachmentIds:[upload.body.attachment.id]});assert.equal(incident.status,200);
  const backup=(await call(db,'/backup')).body,revision=(await snapshot(db)).revision;const args={revision,backup,reason:'Teste de recuperação de arquivo',idempotencyKey:'restore-v3-attachment'};
  const key=[...bucket.data.keys()][0],contents=bucket.data.get(key);bucket.data.delete(key);
  const bad=await call(db,'/restore','POST',args,owner,resources);assert.equal(bad.status,422);assert.equal(bad.body.error.code,'ATTACHMENTS_UNAVAILABLE');assert.equal((await snapshot(db)).revision,revision);
  bucket.data.set(key,contents);assert.equal((await call(db,'/restore','POST',args,owner,resources)).status,200);
});
test('alteração concorrente de perfil ou revisão impede gravação de permissões',async()=>{
  const db=await setup(),gate=await member(db,'gate'),revision=(await snapshot(db)).revision;const original=db.batch.bind(db);let changed=false;db.batch=async function(statements){if(!changed&&statements[0]?.sql.includes('INSERT INTO operational_mutation_guard')){changed=true;this.sqlite.exec('UPDATE operational_meta SET revision=revision+1 WHERE id=1');}return original(statements);};
  const result=await call(db,'/access','POST',{userId:gate.id,overrides:{dataExport:true},reason:'Teste concorrente',revision,idempotencyKey:'v3-concurrent-access'});assert.equal(result.status,409);assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM operational_access').get().n,0);
});
test('tentativa repetida de pré-cadastro retorna sucesso sem duplicar auditoria',async()=>{
  const db=await setup(),payload={action:'invite',email:'repeat@example.test',name:'Equipe',role:'gate',idempotencyKey:'v3-invite-repeat'};const first=await call(db,'/users','POST',payload);const again=await call(db,'/users','POST',payload);assert.equal(first.status,200);assert.equal(again.status,200);assert.equal(again.body.replayed,true);assert.equal((await snapshot(db)).state.audit.filter(e=>e.action==='USER_INVITE').length,1);
});
