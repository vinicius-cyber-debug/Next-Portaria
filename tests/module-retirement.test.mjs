import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { can, createInitialState, createDemoState, execute, validateState, monthlyPreview } from '../lib/domain.mjs';
import { CAPABILITY_DEFINITIONS, defaultCapabilities, effectiveCapabilities, validateOverrides, visibleSnapshot } from '../lib/access.mjs';
import { PERSON_CATEGORIES } from '../lib/physical-access.mjs';
import { RETIRED_COLLECTIONS, RETIRED_COMMANDS, RETIRED_CAPABILITIES } from '../lib/module-policy.mjs';
import { handleApi, readSnapshot } from '../lib/server.ts';
import { testSession } from './fixture-auth.mjs';

const at='2026-10-01T16:00:00.000Z';
const actor={id:'owner',name:'Administradora',role:'admin',status:'active',email:'owner@example.test'};
const apply=(state,type,payload={})=>execute(state,{type,payload,at},actor);

class D1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');const dir=new URL('../drizzle/',import.meta.url);for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL(name,dir),'utf8'));}
  prepare(sql){const sqlite=this.sqlite;return {sql,params:[],bind(...params){return {...this,params};},async first(){return sqlite.prepare(this.sql).get(...this.params)??null;},async all(){return {results:sqlite.prepare(this.sql).all(...this.params),success:true};},async run(){const result=sqlite.prepare(this.sql).run(...this.params);return {results:[],success:true,meta:{changes:Number(result.changes)}};}};}
  async batch(statements){this.sqlite.exec('BEGIN');try{const result=statements.map(statement=>({results:this.sqlite.prepare(statement.sql).all(...statement.params),success:true}));this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}
let sequence=0;
async function api(db,path,method='GET',body){
  const headers={cookie:testSession(db,actor)};
  if(method!=='GET')Object.assign(headers,{origin:'https://porto.example.test','content-type':'application/json'});
  const result=await handleApi(new Request('https://porto.example.test/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),db);
  return {status:result.status,body:await result.json()};
}
async function command(db,type,payload={}){
  const revision=(await api(db,'/state')).body.revision;
  return api(db,'/commands','POST',{type,payload,revision,idempotencyKey:`retired-test-${++sequence}`});
}
function historicalState(){
  const state=createDemoState(at),metadata={createdAt:at,createdBy:actor.name,updatedAt:at,updatedBy:actor.name};
  state.people[0].category='crew';
  const stay=state.stays.find(record=>record.status==='active');
  state.crewManifests.push({id:'historical_manifest',stayId:stay.id,vesselId:null,personIds:[state.people[0].id],responsiblePersonId:state.people[0].id,active:true,notes:'Histórico',...metadata});
  state.vessels.push({id:'historical_vessel',name:'Embarcação histórica',registration:'HIST-1',active:false,updatedAt:at,updatedBy:actor.name});
  state.contracts.push({id:'historical_contract',name:'Contrato histórico',client:'Cliente histórico',dailyRateCents:10000,toleranceMinutes:0,dueDays:7,validFrom:'2025-01-01T00:00:00.000Z',validUntil:'2027-01-01T00:00:00.000Z',active:false,version:1,...metadata});
  state.reservations.push({id:'historical_reservation',vesselName:'Embarcação histórica',registration:'HIST-1',client:'Cliente histórico',berth:state.berths[0],start:'2026-10-02T12:00:00.000Z',end:'2026-10-03T12:00:00.000Z',status:'cancelled',stayId:null,reason:'Cancelamento histórico',cancelledAt:at,cancelledBy:actor.name,...metadata});
  const preview=monthlyPreview(state,state.charges[0].client,'2026-09');
  state.settlements.push({id:'historical_settlement',...preview,reason:'Histórico',...metadata});
  return state;
}

test('domínio rejeita módulos removidos antes de verificar o perfil',()=>{
  const state=createInitialState();
  for(const type of RETIRED_COMMANDS){
    assert.equal(can('admin',type),false,type);
    assert.throws(()=>apply(state,type),{code:'MODULE_REMOVED'},type);
    assert.throws(()=>execute(state,{type,payload:{},at},{...actor,role:'reader'}),{code:'MODULE_REMOVED'},type);
  }
  for(const [type,payload] of [
    ['MASTER_SAVE',{kind:'vessels',record:{name:'Barco'}}],
    ['MASTER_SAVE',{kind:'people',record:{name:'Tripulante',category:'crew'}}],
    ['RECORD_CORRECT',{kind:'stay',id:'legacy'}],
    ['VISITOR_REQUEST',{destinationType:'vessel'}],
    ['VISITOR_REQUEST',{stayId:'legacy'}],
    ['RECORD_CORRECT',{kind:'visitor',changes:{stayId:'legacy'}}],
    ['SETTINGS_UPDATE',{dailyRateCents:1}],
    ['SETTINGS_UPDATE',{overdueHours:48}],
  ])assert.throws(()=>apply(state,type,payload),{code:'MODULE_REMOVED'});
  assert.equal(can('finance','SETTINGS_UPDATE'),false);
  assert.equal(can('gate','VEHICLE_ENTER'),true);
  assert.equal(apply(state,'SETTINGS_UPDATE',{unitName:'Portaria principal'}).state.settings.unitName,'Portaria principal');
  assert.equal(PERSON_CATEGORIES.includes('crew'),false);
});

test('permissões legadas são preservadas sem reativar capacidades removidas',()=>{
  const legacy=Object.fromEntries(RETIRED_CAPABILITIES.map(key=>[key,true]));
  assert.deepEqual(validateOverrides(legacy),legacy);
  const capabilities=effectiveCapabilities({...actor,role:'gate'},legacy);
  for(const key of RETIRED_CAPABILITIES){assert.equal(Object.hasOwn(capabilities,key),false);assert.equal(CAPABILITY_DEFINITIONS.some(definition=>definition.key===key),false);}
});

test('vínculos legados não permitem novas aprovações ou entradas, mas permitem saída',()=>{
  for(const link of ['crew','stay','vessel']){
    const state=historicalState(),visit=state.visitors[0];
    state.people[0].category='visitor';
    if(link==='crew')state.people[0].category='crew';
    if(link==='stay')visit.stayId=state.stays.find(stay=>stay.status==='active').id;
    if(link==='vessel')visit.destinationType='vessel';
    assert.throws(()=>apply(state,'VISITOR_APPROVE',{id:visit.id}),{code:'MODULE_REMOVED'},link);
    Object.assign(visit,{status:'authorized',approvedAt:at,approvedBy:actor.name});
    assert.throws(()=>apply(state,'VISITOR_CHECKIN',{id:visit.id,identityConfirmed:true}),{code:'MODULE_REMOVED'},link);
    Object.assign(visit,{status:'inside',enteredAt:at,checkedInBy:actor.name,identityConfirmedAt:at,identityConfirmedBy:actor.name});
    assert.doesNotThrow(()=>validateState(structuredClone(state)),link);
    const checkedOut=apply(state,'VISITOR_CHECKOUT',{id:visit.id});
    assert.equal(checkedOut.result.status,'completed',link);
    assert.doesNotThrow(()=>validateState(checkedOut.state),link);
  }
  const state=historicalState();
  assert.throws(()=>apply(state,'VISITOR_REQUEST',{personId:state.people[0].id,purpose:'Nova visita',host:actor.name,expectedAt:at,validUntil:'2026-10-02T16:00:00.000Z'}),{code:'MODULE_REMOVED'});
  assert.throws(()=>execute(state,{type:'MASTER_SAVE',payload:{kind:'companies',record:{name:'Empresa'}},at},{...actor,role:'finance'}),{code:'FORBIDDEN'});
});

test('validação e exportação histórica preservam todos os módulos aposentados',()=>{
  const state=historicalState(),restored=validateState(structuredClone(state));
  for(const collection of RETIRED_COLLECTIONS)assert.deepEqual(restored[collection],state[collection],collection);
  assert.deepEqual(restored.berths,state.berths);
  assert.equal(restored.people[0].category,'crew');
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(restored))),restored);
  const visible=visibleSnapshot({state,revision:1},{...actor,capabilities:defaultCapabilities('admin')});
  for(const collection of RETIRED_COLLECTIONS)assert.deepEqual(visible.state[collection],[]);
  assert.deepEqual(visible.state.berths,[]);
  assert.equal(visible.state.settings.dailyRateCents,undefined);
  assert.equal(state.stays.length,2);
});

test('API bloqueia comandos, relatórios e novas atribuições de perfil financeiro',async()=>{
  const db=new D1();
  try{
    for(const type of RETIRED_COMMANDS){const result=await command(db,type);assert.equal(result.status,400,type);assert.equal(result.body.error.code,'MODULE_REMOVED',type);}
    for(const [type,payload] of [['MASTER_SAVE',{kind:'vessels'}],['VISITOR_REQUEST',{destinationType:'vessel'}],['SETTINGS_UPDATE',{dailyRateCents:5}]])assert.equal((await command(db,type,payload)).body.error.code,'MODULE_REMOVED');
    for(const collection of RETIRED_COLLECTIONS){const result=await api(db,'/records?collection='+collection);assert.equal(result.status,400);assert.equal(result.body.error.code,'MODULE_REMOVED');}
    for(const path of ['/monthly-preview?client=Teste&month=2026-09','/exports?kind=stays','/exports?kind=charges'])assert.equal((await api(db,path)).body.error.code,'MODULE_REMOVED');
    const invited=await api(db,'/users','POST',{action:'invite',email:'finance@example.test',role:'finance',idempotencyKey:'retired-role-invite'});
    assert.equal(invited.body.error.code,'MODULE_REMOVED');
  }finally{db.sqlite.close();}
});

test('API confere a pessoa de uma visita legada mesmo quando o comando contém somente id',async()=>{
  const db=new D1();
  try{
    const now=new Date().toISOString(),state=createDemoState(now),visit=state.visitors[0];
    state.people[0].category='crew';
    const revision=(await api(db,'/state')).body.revision;
    const restored=await api(db,'/restore','POST',{revision,backup:{format:'porto-gestao-backup',version:2,exportedAt:now,revision:0,state:{...state,audit:[]},auditIncluded:false},reason:'Conferência do legado',idempotencyKey:'retired-person-restore'});
    assert.equal(restored.status,200);
    assert.equal((await command(db,'VISITOR_APPROVE',{id:visit.id})).body.error.code,'MODULE_REMOVED');
    Object.assign(visit,{status:'authorized',approvedAt:now,approvedBy:actor.name});
    db.sqlite.prepare("UPDATE operational_records SET body=? WHERE collection='visitors' AND id=?").run(JSON.stringify(visit),visit.id);
    assert.equal((await command(db,'VISITOR_CHECKIN',{id:visit.id,identityConfirmed:true})).body.error.code,'MODULE_REMOVED');
    Object.assign(visit,{status:'inside',enteredAt:now,checkedInBy:actor.name,identityConfirmedAt:now,identityConfirmedBy:actor.name});
    db.sqlite.prepare("UPDATE operational_records SET body=? WHERE collection='visitors' AND id=?").run(JSON.stringify(visit),visit.id);
    const checkout=await command(db,'VISITOR_CHECKOUT',{id:visit.id});
    assert.equal(checkout.status,200);assert.equal(checkout.body.result.status,'completed');
    assert.equal((await readSnapshot(db)).state.people[0].category,'crew');
  }finally{db.sqlite.close();}
});

test('backup e restauração mantêm histórico enquanto estado e notificações permanecem ativos',async()=>{
  const db=new D1();
  try{
    const state=historicalState(),revision=(await api(db,'/state')).body.revision;
    const backup={format:'porto-gestao-backup',version:2,exportedAt:at,revision:0,state:{...state,audit:[]},auditIncluded:false};
    const restored=await api(db,'/restore','POST',{revision,backup,reason:'Compatibilidade de histórico',idempotencyKey:'retired-history-restore'});
    assert.equal(restored.status,200,JSON.stringify(restored.body));
    const exported=(await api(db,'/backup')).body;
    const byId=records=>[...records].sort((a,b)=>a.id.localeCompare(b.id));
    for(const collection of RETIRED_COLLECTIONS)assert.deepEqual(byId(exported.state[collection]),byId(state[collection]));
    const raw=await readSnapshot(db);assert.equal(raw.state.stays.length,2);
    const visible=(await api(db,'/state')).body;
    for(const collection of RETIRED_COLLECTIONS)assert.deepEqual(visible.state[collection],[]);
    const reset=(await api(db,'/sync?since=0&forceReset=true')).body;
    for(const collection of RETIRED_COLLECTIONS)assert.deepEqual(reset.state[collection],[]);
    const config={backupEnabled:false,everyHours:24,retentionDays:30,notificationsEnabled:true,noticeKinds:['stay_overstay','charge_overdue','visitor_pending'],recipientRoles:['admin','finance']};
    db.sqlite.prepare('INSERT INTO operational_continuity_config (id,body) VALUES (?,?)').run('default',JSON.stringify(config));
    for(const kind of ['stay_overstay','charge_overdue']){
      const notice={id:'legacy_'+kind,kind,entityId:'legacy',createdAt:at,title:'Aviso histórico',description:'Histórico',roles:['admin'],section:'finance',resolvedAt:null};
      db.sqlite.prepare('INSERT INTO operational_notifications (id,kind,entity_id,created_at,body) VALUES (?,?,?,?,?)').run(notice.id,kind,notice.entityId,at,JSON.stringify(notice));
    }
    const notices=await api(db,'/notifications');assert.equal(notices.status,200);assert.deepEqual(notices.body.notifications,[]);
    const continuity=await api(db,'/continuity');assert.deepEqual(continuity.body.config.noticeKinds,['visitor_pending']);assert.deepEqual(continuity.body.config.recipientRoles,['admin']);
    assert.equal(continuity.body.notificationSummary.active,0);
    assert.deepEqual(JSON.parse(db.sqlite.prepare('SELECT body FROM operational_continuity_config WHERE id=?').get('default').body),config);
  }finally{db.sqlite.close();}
});
