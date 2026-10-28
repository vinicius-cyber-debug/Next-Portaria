import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handleApi} from '../lib/server.ts';
import {createDemoState} from '../lib/domain.mjs';
import {testSession} from './fixture-auth.mjs';

/** SQLite real, mesmas migrações e batch atômico do contrato D1. Dados apenas em memória. */
class D1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');const dir=new URL('../drizzle/',import.meta.url);for(const name of readdirSync(dir).filter(p=>p.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(name,dir),'utf8'));}
  prepare(sql){const owner=this;return {sql,params:[],bind(...params){return {...this,params};},async first(){return owner.sqlite.prepare(this.sql).get(...this.params)??null;},async all(){return {results:owner.sqlite.prepare(this.sql).all(...this.params),success:true};},async run(){const r=owner.sqlite.prepare(this.sql).run(...this.params);return {results:[],success:true,meta:{changes:Number(r.changes)}};}};}
  async batch(statements){this.sqlite.exec('BEGIN');try{const result=statements.map(s=>({results:this.sqlite.prepare(s.sql).all(...s.params),success:true}));this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}
const origin='https://porto.example.test',owner={id:'access-owner',name:'Administradora fictícia',email:'access-owner@example.test'};
let sequence=0;
async function call(db,path,method='GET',body,user=owner,base=origin,extra={},resources={}){
  const headers={...extra},cookie=testSession(db,user);if(cookie)headers.cookie=cookie;
  if(method!=='GET'){headers.origin??=base;headers['content-type']??='application/json';}
  const response=await handleApi(new Request(base+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),db,resources);
  return {status:response.status,body:await response.json(),response};
}
async function snapshot(db,user=owner){const r=await call(db,'/state','GET',undefined,user);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
async function command(db,type,payload,user=owner,idempotencyKey=`access-command-${++sequence}`){return call(db,'/commands','POST',{type,payload,revision:(await snapshot(db,user)).revision,idempotencyKey},user);}
async function ok(db,type,payload,user=owner){const r=await command(db,type,payload,user);assert.equal(r.status,200,`${type}: ${JSON.stringify(r.body)}`);return r.body.result;}
async function setup(){const db=new D1();assert.equal((await call(db,'/session')).status,200);return db;}
async function member(db,role){const user={id:`access-${role}`,name:role,email:`access-${role}@example.test`};assert.equal((await call(db,'/users','POST',{action:'invite',...user,role,idempotencyKey:`access-invite-${++sequence}`})).status,200);assert.equal((await call(db,'/session','GET',undefined,user)).body.user.role,role);return user;}
async function grant(db,user,overrides){const r=await call(db,'/access','POST',{userId:user.id,overrides,reason:'Verificação fictícia de permissões',revision:(await snapshot(db)).revision,idempotencyKey:`access-permission-${++sequence}`});assert.equal(r.status,200,JSON.stringify(r.body));}
async function person(db,record={}){return ok(db,'MASTER_SAVE',{kind:'people',record:{name:`Pessoa fictícia ${++sequence}`,company:'Empresa fictícia',...record}});}
async function visit(db,payload={},user=owner){return ok(db,'VISITOR_REQUEST',{name:'Visitante fictício',company:'Empresa fictícia',purpose:'Teste de acesso',host:'Responsável fictício',expectedAt:new Date(Date.now()-3600000).toISOString(),validUntil:new Date(Date.now()+7200000).toISOString(),...payload},user);}
async function approved(db,payload={}){const v=await visit(db,payload);await ok(db,'VISITOR_APPROVE',{id:v.id});return v;}
async function area(db,record={}){return ok(db,'ACCESS_AREA_SAVE',{record:{name:`Área fictícia ${++sequence}`,restricted:false,active:true,...record}});}
async function issue(db,visitorId){const r=await call(db,'/passes/issue','POST',{visitorId,revision:(await snapshot(db)).revision,idempotencyKey:`access-pass-${++sequence}`});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.pass.code;}
async function rejected(db,type,payload,code,user=owner){const before=await snapshot(db),r=await command(db,type,payload,user);assert.equal(r.status,400,JSON.stringify(r.body));assert.equal(r.body.error.code,code);assert.equal((await snapshot(db)).revision,before.revision);return r;}

test('portaria cadastra chegada pendente, diretoria autoriza e cada entrada exige conferência explícita',async()=>{
  const db=await setup(),gate=await member(db,'gate'),director=await member(db,'director'),v=await visit(db,{},gate);
  assert.equal(v.status,'pending');assert.ok(v.personId);assert.equal((await command(db,'VISITOR_APPROVE',{id:v.id},gate)).status,403);
  await rejected(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true},'INVALID_TRANSITION',gate);
  await ok(db,'VISITOR_APPROVE',{id:v.id},director);
  for(const identityConfirmed of [undefined,false,'true',1])await rejected(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed},'IDENTITY_REQUIRED',gate);
  const entered=await ok(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true},gate);assert.equal(entered.status,'inside');assert.ok(entered.enteredAt);assert.ok(entered.checkedInBy);assert.equal(entered.identityConfirmedBy,gate.name);assert.equal(entered.identityConfirmedAt,entered.enteredAt);
  assert.equal((await snapshot(db)).state.visitors.filter(row=>row.status==='inside').length,1);
  await ok(db,'VISITOR_CHECKOUT',{id:v.id},gate);
  await rejected(db,'VISITOR_CHECKOUT',{id:v.id},'INVALID_TRANSITION',gate);
});

test('histórico usa cadastro único e impede segunda presença da mesma pessoa',async()=>{
  const db=await setup(),first=await approved(db,{name:'Ana fictícia',documentLast4:'1234'}),second=await approved(db,{name:'Ana fictícia',documentLast4:'1234'});
  assert.equal(first.personId,second.personId);assert.equal((await snapshot(db)).state.people.length,1);
  await ok(db,'VISITOR_CHECKIN',{id:first.id,identityConfirmed:true});
  await rejected(db,'VISITOR_CHECKIN',{id:second.id,identityConfirmed:true},'DUPLICATE');
  await ok(db,'VISITOR_CHECKOUT',{id:first.id});await ok(db,'VISITOR_CHECKIN',{id:second.id,identityConfirmed:true});
  const state=(await snapshot(db)).state;assert.equal(state.visitors.filter(v=>v.personId===first.personId).length,2);assert.equal(state.people.length,1);
});

test('desativação e segurança pendente ou bloqueada impedem acesso e desativação invalida o QR',async()=>{
  const db=await setup(),p=await person(db,{name:'Prestador fictício',category:'contractor',securityStatus:'cleared'}),v=await approved(db,{personId:p.id}),code=await issue(db,v.id);
  await ok(db,'MASTER_SAVE',{kind:'people',record:{...p,securityStatus:'pending'}});
  await rejected(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true},'SECURITY_PENDING');
  await ok(db,'MASTER_SAVE',{kind:'people',record:{...p,securityStatus:'blocked',restrictions:'Validação de segurança fictícia pendente'}});
  assert.equal((await command(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true})).status,400);
  assert.equal((await snapshot(db)).state.visitors.find(row=>row.id===v.id).status,'revoked');
  const blocked=await visit(db,{personId:p.id});await rejected(db,'VISITOR_APPROVE',{id:blocked.id},'ACCESS_BLOCKED');
  await ok(db,'MASTER_SAVE',{kind:'people',record:{...p,active:false}});
  assert.equal((await command(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true})).status,400);
  assert.equal((await call(db,'/passes/lookup','POST',{code})).status,404);
  await rejected(db,'VISITOR_REQUEST',{name:p.name,company:p.company,personId:p.id,purpose:'Teste',host:'Responsável',expectedAt:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+10000).toISOString()},'INACTIVE_MASTER');
});

test('área restrita exige permissão individual atual na autorização e na entrada',async()=>{
  const db=await setup(),a=await area(db,{restricted:true}),p=await person(db),v=await visit(db,{personId:p.id,areaId:a.id});
  await rejected(db,'VISITOR_APPROVE',{id:v.id},'AREA_PERMISSION_REQUIRED');
  await ok(db,'MASTER_SAVE',{kind:'people',record:{...p,allowedAreaIds:[a.id]}});await ok(db,'VISITOR_APPROVE',{id:v.id});
  const code=await issue(db,v.id);await ok(db,'MASTER_SAVE',{kind:'people',record:{...p,allowedAreaIds:[]}});
  await rejected(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true},'AREA_PERMISSION_REQUIRED');
  assert.notEqual((await call(db,'/passes/lookup','POST',{code})).status,200);
  await ok(db,'MASTER_SAVE',{kind:'people',record:{...p,allowedAreaIds:[a.id]}});await ok(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true});
});

test('destino de embarcação, tripulação e manifesto aposentados são rejeitados',async()=>{
  const db=await setup(),a=await area(db),p=await person(db),now=Date.now();
  const payload={personId:p.id,areaId:a.id,name:p.name,company:'Empresa fictícia',purpose:'Teste de acesso',host:'Responsável',expectedAt:new Date(now-3600000).toISOString(),validUntil:new Date(now+7200000).toISOString()};
  for(const destination of [{stayId:'stay_legacy'},{destinationType:'vessel'},{category:'crew'}])await rejected(db,'VISITOR_REQUEST',{...payload,...destination},'MODULE_REMOVED');
  await rejected(db,'CREW_MANIFEST_SAVE',{record:{stayId:'stay_legacy',personIds:[p.id],responsiblePersonId:p.id}},'MODULE_REMOVED');
  await rejected(db,'MASTER_SAVE',{kind:'people',record:{name:'Tripulante fictício',category:'crew'}},'MODULE_REMOVED');
  const current=await approved(db,{personId:p.id,areaId:a.id});await ok(db,'VISITOR_CHECKIN',{id:current.id,identityConfirmed:true});assert.equal((await snapshot(db)).state.visitors[0].status,'inside');
});
test('veículo, motorista e acompanhantes mantêm movimentos de presença independentes',async()=>{
  const db=await setup(),driver=await person(db,{category:'driver'}),passenger=await person(db),v=await approved(db,{personId:driver.id});
  const vehicle=await ok(db,'VEHICLE_ENTER',{plate:'QAT1A23',driver:driver.name,company:'Empresa fictícia',purpose:'Entrega fictícia',visitorId:v.id,driverPersonId:driver.id,occupantPersonIds:[passenger.id],cargo:'Material de teste'});
  let state=(await snapshot(db)).state;assert.equal(state.visitors[0].status,'authorized');assert.equal(state.visitors.filter(row=>row.status==='inside').length,0);assert.deepEqual(vehicle.occupantPersonIds,[passenger.id]);
  await ok(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true});await ok(db,'VEHICLE_EXIT',{id:vehicle.id});state=(await snapshot(db)).state;assert.equal(state.visitors[0].status,'inside');assert.equal(state.vehicles[0].status,'completed');
  await ok(db,'VISITOR_CHECKOUT',{id:v.id});assert.equal((await snapshot(db)).state.visitors[0].status,'completed');
});

test('revogação de autorização bloqueia QR e entrada mesmo após emissão',async()=>{
  const db=await setup(),v=await approved(db),code=await issue(db,v.id);await ok(db,'VISITOR_REVOKE',{id:v.id,reason:'Solicitação fictícia cancelada pelo responsável'});
  assert.equal((await call(db,'/passes/lookup','POST',{code})).status,400);await rejected(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true},'INVALID_TRANSITION');
});

test('HTTPS é obrigatório na rede e cabeçalho encaminhado não contorna a verificação',async()=>{
  const db=await setup();for(const path of ['/session','/state']){const r=await call(db,path,'GET',undefined,owner,'http://192.168.10.10:5173',{'x-forwarded-proto':'https'});assert.equal(r.status,403);assert.equal(r.body.error.code,'HTTPS_REQUIRED');}
  const login=await call(db,'/auth/login','POST',{username:'ficticio',password:'ficticio'},null,'http://192.168.10.10:5173');assert.equal(login.status,403);assert.equal(login.body.error.code,'HTTPS_REQUIRED');
  assert.equal((await call(db,'/session','GET',undefined,owner,'http://127.0.0.1:5173')).status,200);
});

test('exceção temporária HTTP exige configuração do servidor e preserva login, origem e bloqueio público',async()=>{
  const db=await setup(),resources={allowHttpLan:true};
  for(const host of ['10.0.0.5','172.16.0.5','172.31.255.5','192.168.3.227']) {
    const r=await call(db,'/session','GET',undefined,owner,`http://${host}:5173`,{},resources);
    assert.equal(r.status,200);assert.equal(r.body.environment,'local');
  }
  const base='http://192.168.3.227:5173';
  assert.equal((await call(db,'/session','GET',undefined,null,base,{},resources)).status,401);
  const login=await call(db,'/auth/login','POST',{username:'inexistente',password:'ficticia'},null,base,{},resources);
  assert.equal(login.status,401);assert.equal(login.body.error.code,'INVALID_LOGIN');
  const csrf=await call(db,'/auth/login','POST',{},null,base,{origin:'http://outro.example'},resources);
  assert.equal(csrf.status,403);assert.equal(csrf.body.error.code,'CSRF');
  for(const host of ['172.15.0.5','172.32.0.5','192.169.0.5','8.8.8.8','porto.example','192.168.3.227.example']) {
    const r=await call(db,'/session','GET',undefined,owner,`http://${host}:5173`,{},resources);
    assert.equal(r.status,403);assert.equal(r.body.error.code,'HTTPS_REQUIRED');
  }
  const withoutFlag=await call(db,'/session','GET',undefined,owner,base,{'x-porto-allow-http-lan':'true'});
  assert.equal(withoutFlag.status,403);assert.equal(withoutFlag.body.error.code,'HTTPS_REQUIRED');
});

test('permissões individuais não transformam Consulta em aprovador ou operador de acesso',async()=>{
  const db=await setup(),reader=await member(db,'reader'),gate=await member(db,'gate'),director=await member(db,'director'),v=await visit(db);
  await grant(db,reader,{gateOperate:true,exceptionApprove:true,documentView:true});
  for(const type of ['VISITOR_APPROVE','VISITOR_CHECKIN','ACCESS_AREA_SAVE','EMERGENCY_START'])assert.equal((await command(db,type,{id:v.id,identityConfirmed:true,title:'Teste',record:{name:'Área'}},reader)).status,403,type);
  const p=(await snapshot(db)).state.people.find(row=>row.id===v.personId);assert.equal((await command(db,'MASTER_SAVE',{kind:'people',record:{...p,securityStatus:'cleared',restrictions:'Alteração indevida de segurança'}},gate)).status,403);
  assert.equal((await command(db,'MASTER_SAVE',{kind:'people',record:{name:'Funcionário indevido fictício',category:'employee'}},gate)).status,403);
  assert.equal((await command(db,'VISITOR_REQUEST',{name:'Funcionário indevido fictício',company:'Empresa',category:'employee',purpose:'Teste',host:'Responsável',expectedAt:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+3600000).toISOString()},gate)).status,403);
  await grant(db,director,{accessManage:false});assert.equal((await command(db,'MASTER_SAVE',{kind:'people',record:{name:'Prestador indevidamente liberado',category:'contractor',securityStatus:'cleared'}},director)).status,403);assert.equal((await command(db,'MASTER_SAVE',{kind:'people',record:{...p,category:'contractor',securityStatus:'cleared'}},director)).status,403);
  await grant(db,gate,{gateOperate:false});await ok(db,'VISITOR_APPROVE',{id:v.id});assert.equal((await command(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true},gate)).status,403);
});

test('emergência preserva lista de presentes e reconcilia conferência física sem alterar movimentos',async()=>{
  const db=await setup(),gate=await member(db,'gate'),reader=await member(db,'reader'),a=await area(db),p=await person(db,{documentLast4:'9876',contact:'Contato documental reservado'}),v=await approved(db,{personId:p.id,areaId:a.id,documentLast4:'9876'});
  await ok(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true},gate);const pending=await visit(db,{areaId:a.id,name:'Pessoa ainda aguardando'});
  const emergency=await ok(db,'EMERGENCY_START',{title:'Exercício fictício de conferência'},gate);
  assert.equal(emergency.people.length,1);assert.equal(emergency.people[0].visitorId,v.id);assert.equal(emergency.people[0].areaId,a.id);assert.ok(emergency.people[0].host);assert.equal(emergency.people[0].confirmedAt,null);
  await ok(db,'VISITOR_CHECKOUT',{id:v.id},gate);
  await ok(db,'EMERGENCY_RECONCILE',{id:emergency.id,visitorId:v.id,confirmed:true,note:'Conferido pessoalmente no ponto de encontro fictício'},gate);
  const current=(await snapshot(db)).state,roll=current.emergencyRollCalls.find(row=>row.id===emergency.id);assert.ok(roll.people[0].confirmedAt);assert.ok(roll.people[0].confirmedBy);assert.equal(current.visitors.find(row=>row.id===v.id).status,'completed');assert.equal(current.visitors.find(row=>row.id===pending.id).status,'pending');
  const readOnly=(await snapshot(db,reader)).state;assert.equal(readOnly.emergencyRollCalls[0].people.length,1);assert.equal(readOnly.audit.length,0);assert.doesNotMatch(JSON.stringify(readOnly),/9876|Contato documental reservado/);
  assert.equal((await command(db,'EMERGENCY_RECONCILE',{id:emergency.id,visitorId:v.id,confirmed:true},reader)).status,403);
  await ok(db,'EMERGENCY_CLOSE',{id:emergency.id,reason:'Conferência fictícia concluída'},gate);
  await rejected(db,'EMERGENCY_RECONCILE',{id:emergency.id,visitorId:v.id,confirmed:false},'INVALID_TRANSITION',gate);
  await grant(db,gate,{emergencyManage:false});assert.equal((await command(db,'EMERGENCY_START',{title:'Sem permissão'},gate)).status,403);
});

test('backup restaura acesso e manifesto histórico; vínculos adulterados são rejeitados',async()=>{
  const db=await setup(),a=await area(db,{restricted:true}),p=await person(db,{allowedAreaIds:[a.id],documentLast4:'2468'}),responsible=await person(db,{category:'employee'});
  const v=await approved(db,{personId:p.id,areaId:a.id});await ok(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true});const emergency=await ok(db,'EMERGENCY_START',{title:'Lista fictícia para restauração'});
  const backup=(await call(db,'/backup')).body,historical=createDemoState(),at=new Date().toISOString();
  for(const kind of ['stays','charges','vessels','berths','tariffHistory','contracts','reservations','settlements'])backup.state[kind]=historical[kind];
  backup.state.people.find(row=>row.id===p.id).category='crew';
  const manifest={id:'manifest_legacy',stayId:historical.stays.find(row=>row.status==='active').id,vesselId:null,responsiblePersonId:responsible.id,personIds:[p.id,responsible.id],active:true,notes:'Histórico preservado',createdAt:at,createdBy:owner.name,updatedAt:at,updatedBy:owner.name};backup.state.crewManifests=[manifest];
  assert.equal(backup.format,'porto-gestao-backup');assert.equal(backup.state.audit.length,0);assert.equal(backup.state.accessAreas[0].id,a.id);assert.equal(backup.state.emergencyRollCalls[0].id,emergency.id);
  for(const mutate of [b=>{b.state.visitors[0].areaId='area_inexistente';},b=>{b.state.crewManifests[0].personIds=['person_inexistente'];},b=>{b.state.emergencyRollCalls[0].people[0].visitorId='visit_inexistente';}]){
    const forged=structuredClone(backup);mutate(forged);const before=await snapshot(db),r=await call(db,'/restore','POST',{revision:before.revision,backup:forged,reason:'Teste fictício de vínculo inválido',idempotencyKey:'bad-restore-'+(++sequence)});assert.equal(r.status,422,JSON.stringify(r.body));assert.equal((await snapshot(db)).revision,before.revision);
  }
  await ok(db,'EMERGENCY_RECONCILE',{id:emergency.id,visitorId:v.id,confirmed:true});const restored=await call(db,'/restore','POST',{revision:(await snapshot(db)).revision,backup,reason:'Teste fictício de recuperação operacional',idempotencyKey:'good-restore-'+(++sequence)});assert.equal(restored.status,200,JSON.stringify(restored.body));
  const state=(await snapshot(db)).state,saved=(await call(db,'/backup')).body.state;assert.equal(state.people.find(row=>row.id===p.id).category,'crew');assert.deepEqual(state.people.find(row=>row.id===p.id).allowedAreaIds,[a.id]);assert.deepEqual(state.crewManifests,[]);assert.equal(saved.crewManifests[0].id,manifest.id);assert.equal(state.emergencyRollCalls[0].people[0].confirmedAt,null);assert.ok(state.audit.some(row=>row.action==='BACKUP_RESTORE'));
});
test('saída sem entrada exige justificativa e autorização e registra evidência sem inventar presença',async()=>{
  const db=await setup(),gate=await member(db,'gate'),director=await member(db,'director'),p=await person(db),occurredAt=new Date(Date.now()-60000).toISOString();
  const payload={personId:p.id,occurredAt,gateName:'Portaria principal',reason:'Pessoa encontrada na saída sem entrada registrada; conferida fisicamente pelo responsável'};
  assert.equal((await command(db,'ACCESS_EXIT_CORRECT',payload,gate)).status,403);
  await rejected(db,'ACCESS_EXIT_CORRECT',{...payload,reason:''},'VALIDATION',director);
  assert.equal((await command(db,'ACCESS_EXIT_CORRECT',{...payload,occurredAt:new Date(Date.now()+3600000).toISOString()},director)).status,400);
  const evidence=await ok(db,'ACCESS_EXIT_CORRECT',payload,director),state=(await snapshot(db)).state;assert.equal(evidence.type,'exit_without_entry');assert.equal(evidence.personId,p.id);assert.equal(evidence.createdBy,director.name);assert.equal(state.visitors.length,0);assert.equal(state.accessCorrections.length,1);assert.ok(state.audit.some(row=>row.action==='ACCESS_EXIT_CORRECT'));
  const backup=(await call(db,'/backup')).body;assert.equal(backup.state.accessCorrections[0].id,evidence.id);
  const restored=await call(db,'/restore','POST',{revision:(await snapshot(db)).revision,backup,reason:'Teste fictício de preservação da correção',idempotencyKey:`restore-correction-${++sequence}`});assert.equal(restored.status,200,JSON.stringify(restored.body));assert.equal((await snapshot(db)).state.accessCorrections[0].id,evidence.id);
  const v=await approved(db,{personId:p.id});await ok(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true});const before=await snapshot(db);assert.equal((await command(db,'ACCESS_EXIT_CORRECT',payload,director)).status,400);const after=await snapshot(db);assert.equal(after.revision,before.revision);assert.equal(after.state.visitors[0].status,'inside');assert.equal(after.state.accessCorrections.length,1);
  await grant(db,director,{exceptionApprove:false});assert.equal((await command(db,'ACCESS_EXIT_CORRECT',payload,director)).status,403);
});

test('restaurar presença antiga substitui outra visita atual da mesma pessoa em transação única',async()=>{
  const db=await setup(),p=await person(db),first=await approved(db,{personId:p.id});await ok(db,'VISITOR_CHECKIN',{id:first.id,identityConfirmed:true});const backup=(await call(db,'/backup')).body;
  await ok(db,'VISITOR_CHECKOUT',{id:first.id});const second=await approved(db,{personId:p.id});await ok(db,'VISITOR_CHECKIN',{id:second.id,identityConfirmed:true});
  const restored=await call(db,'/restore','POST',{revision:(await snapshot(db)).revision,backup,reason:'Recuperação fictícia de fotografia anterior com presença diferente',idempotencyKey:`restore-old-presence-${++sequence}`});assert.equal(restored.status,200,JSON.stringify(restored.body));
  const state=(await snapshot(db)).state;assert.equal(state.visitors.filter(row=>row.status==='inside').length,1);assert.equal(state.visitors.find(row=>row.status==='inside').id,first.id);assert.equal(state.visitors.some(row=>row.id===second.id),false);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM operational_records WHERE collection='visitors' AND record_person_id=? AND record_status='inside'").get(p.id).n,1);
});

test('trocar pessoa de visita presente exige reconferência de identidade e preserva auditoria',async()=>{
  const db=await setup(),director=await member(db,'director'),original=await person(db),correct=await person(db),v=await approved(db,{personId:original.id});await ok(db,'VISITOR_CHECKIN',{id:v.id,identityConfirmed:true});
  const payload={kind:'visitor',id:v.id,reason:'Vínculo cadastral incorreto, documento conferido novamente',changes:{personId:correct.id}};
  await rejected(db,'RECORD_CORRECT',payload,'IDENTITY_REQUIRED',director);const updated=await ok(db,'RECORD_CORRECT',{...payload,identityConfirmed:true},director);assert.equal(updated.personId,correct.id);assert.equal(updated.identityReconfirmedBy,director.name);assert.ok(updated.identityReconfirmedAt);assert.ok(Date.parse(updated.identityReconfirmedAt)>=Date.parse(updated.enteredAt));
  const state=(await snapshot(db)).state;assert.equal(state.visitors.filter(row=>row.status==='inside').length,1);assert.ok(state.audit.some(row=>row.action==='RECORD_CORRECT'&&row.reason===payload.reason));
});
