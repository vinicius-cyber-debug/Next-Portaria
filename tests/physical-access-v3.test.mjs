import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createInitialState,execute,validateState} from '../lib/domain.mjs';
import {normalizePersonAccess,assertVisitEntry,isAfterHours,accessOverview} from '../lib/physical-access.mjs';

const at='2026-10-23T16:00:00.000Z',admin={id:'admin',name:'Administradora',role:'admin'},gate={id:'gate',name:'Porteiro',role:'gate'};
const request={name:'Maria Silva',company:'Empresa A',purpose:'Manutenção',host:'Responsável',expectedAt:'2026-10-23T12:00:00Z',validUntil:'2026-10-23T20:00:00Z'};
const apply=(state,type,payload={},actor=admin,time=at)=>execute(state,{type,payload,at:time},actor);

test('campos de acesso preservam liberação existente e prestador novo aguarda validação',()=>{
  assert.equal(normalizePersonAccess({category:'contractor'}).securityStatus,'pending');
  const previous={id:'p',category:'contractor',securityStatus:'cleared',allowedAreaIds:['area'],restrictions:'Usar EPI',documentLast4:'1234'};
  assert.deepEqual(normalizePersonAccess({name:'Outro nome'},previous),{category:'contractor',securityStatus:'cleared',allowedAreaIds:['area'],restrictions:'Usar EPI',documentLast4:'1234'});
  assert.equal(normalizePersonAccess({category:'contractor'},{id:'v',category:'visitor',securityStatus:'cleared'}).securityStatus,'pending');
  for(const values of [{category:'administrator'},{securityStatus:'approved'},{documentLast4:'12345'},{documentLast4:'AB12'},{allowedAreaIds:['area','area']}])assert.throws(()=>normalizePersonAccess(values));
});

test('cadastro único permite homônimos sem tratar final do documento como identificador global',()=>{
  let first=apply(createInitialState(),'VISITOR_REQUEST',{...request,documentLast4:'1234'}),state=first.state;
  const repeated=apply(state,'VISITOR_REQUEST',{...request,documentLast4:'1234'});assert.equal(repeated.result.personId,first.result.personId);state=repeated.state;
  const homonym=apply(state,'VISITOR_REQUEST',{...request,documentLast4:'5678'});assert.notEqual(homonym.result.personId,first.result.personId);state=homonym.state;
  const other=apply(state,'VISITOR_REQUEST',{...request,name:'Joana Silva',documentLast4:'1234'});assert.notEqual(other.result.personId,first.result.personId);
  assert.throws(()=>apply(state,'VISITOR_REQUEST',request),{code:'VALIDATION'});
  assert.equal(validateState(other.state).people.length,3);
});

test('portaria não concede reativação, segurança liberada, funcionário ou área restrita',()=>{
  let state=apply(createInitialState(),'ACCESS_AREA_SAVE',{record:{name:'Cais',restricted:true}}).state,areaId=state.accessAreas[0].id;
  const created=apply(state,'MASTER_SAVE',{kind:'people',record:{name:'Técnico',category:'contractor',active:false}});state=created.state;
  for(const record of [{id:created.result.id,active:true},{id:created.result.id,securityStatus:'cleared'},{id:created.result.id,allowedAreaIds:[areaId]},{id:created.result.id,category:'employee'},{name:'Funcionário indevido',category:'employee'},{name:'Prestador indevido',category:'contractor',securityStatus:'cleared'}])assert.throws(()=>apply(state,'MASTER_SAVE',{kind:'people',record},gate),{code:'FORBIDDEN'});
  const allowed=apply(state,'MASTER_SAVE',{kind:'people',record:{name:'Visitante comum'}},gate);assert.equal(allowed.result.securityStatus,'cleared');
  assert.throws(()=>apply(allowed.state,'MASTER_SAVE',{kind:'people',record:{id:allowed.result.id,category:'contractor',securityStatus:'cleared'}},gate),{code:'FORBIDDEN'});
  assert.equal(apply(allowed.state,'MASTER_SAVE',{kind:'people',record:{id:allowed.result.id,category:'contractor'}},gate).result.securityStatus,'pending');
});

test('entrada usa conferência por visita e detecta presença legada sem personId',()=>{
  const visit={id:'new',personId:'p',name:'Maria Silva',company:'Empresa A',status:'authorized',expectedAt:request.expectedAt,validUntil:request.validUntil};
  const state={people:[{id:'p',active:true}],visitors:[{...visit,id:'legacy',personId:null,status:'inside'}],accessAreas:[],stays:[]},before=structuredClone(state);
  assert.throws(()=>assertVisitEntry(state,visit,{identityConfirmed:true},at,gate),{code:'DUPLICATE'});assert.deepEqual(state,before);
  state.visitors=[];assert.throws(()=>assertVisitEntry(state,visit,{identityConfirmed:false},at,gate),{code:'IDENTITY_REQUIRED'});
  assert.deepEqual(assertVisitEntry(state,visit,{identityConfirmed:true},at,gate),{identityConfirmedAt:at,identityConfirmedBy:gate.name});
});

test('horários de funcionamento e alertas respeitam fuso local, turno noturno e prazo menor',()=>{
  const settings={timezone:'America/Manaus',openingTime:'08:00',closingTime:'18:00',visitorOverstayHours:8};
  assert.equal(isAfterHours(settings,'2026-10-23T12:00:00Z'),false);assert.equal(isAfterHours(settings,'2026-10-23T22:00:00Z'),true);
  assert.equal(isAfterHours({...settings,openingTime:'20:00',closingTime:'06:00'},'2026-10-24T03:00:00Z'),false);
  assert.equal(isAfterHours({...settings,openingTime:'20:00',closingTime:'06:00'},'2026-10-23T16:00:00Z'),true);
  const summary=accessOverview({settings,people:[],accessAreas:[],visitors:[{...request,id:'v',status:'inside',enteredAt:'2026-10-23T13:00:00Z',validUntil:'2026-10-23T14:00:00Z',gateName:'Principal'}]},at);
  assert.equal(summary.overstayed.length,1);assert.equal(summary.inside[0].elapsedMinutes,180);assert.deepEqual(summary.byGate,[{name:'Principal',count:1}]);
});

test('correção justificada de saída ausente preserva evidência sem inventar presença',()=>{
  const saved=apply(createInitialState(),'MASTER_SAVE',{kind:'people',record:{name:'Maria Silva',company:'Empresa A'}}),personId=saved.result.id;
  assert.throws(()=>apply(saved.state,'ACCESS_EXIT_CORRECT',{personId}),{code:'VALIDATION'});
  assert.throws(()=>apply(saved.state,'ACCESS_EXIT_CORRECT',{personId,reason:'Conferido',occurredAt:'2026-10-24T16:00:00Z'}),{code:'INVALID_PERIOD'});
  assert.throws(()=>apply(saved.state,'ACCESS_EXIT_CORRECT',{personId,reason:'Conferido'},gate),{code:'FORBIDDEN'});
  const corrected=apply(saved.state,'ACCESS_EXIT_CORRECT',{personId,reason:'Saída física confirmada; entrada omitida no turno anterior',occurredAt:'2026-10-23T15:00:00Z'});
  assert.equal(corrected.state.visitors.length,0);assert.equal(corrected.state.accessCorrections.length,1);assert.equal(corrected.state.audit[0].action,'ACCESS_EXIT_CORRECT');assert.equal(corrected.state.audit[0].reason,corrected.result.reason);
  assert.equal(validateState(corrected.state).accessCorrections[0].personId,personId);
  const forged=structuredClone(corrected.state);forged.accessCorrections[0].personId='missing';assert.throws(()=>validateState(forged),{code:'INVALID_BACKUP'});
});

test('correção de pessoa presente exige nova conferência e anotação continua possível após bloqueio',()=>{
  let state=apply(createInitialState(),'VISITOR_REQUEST',request).state,id=state.visitors[0].id;
  state=apply(state,'VISITOR_APPROVE',{id}).state;state=apply(state,'VISITOR_CHECKIN',{id,identityConfirmed:true},gate).state;
  const oldPersonId=state.visitors[0].personId,oldConfirmation=state.visitors[0].identityConfirmedAt;
  const saved=apply(state,'MASTER_SAVE',{kind:'people',record:{name:'Maria homônima',company:'Empresa B'}});state=saved.state;
  const correction={kind:'visitor',id,reason:'Documento conferido após identificação de homônima',changes:{personId:saved.result.id}};
  assert.throws(()=>apply(state,'RECORD_CORRECT',correction),{code:'IDENTITY_REQUIRED'});
  state=apply(state,'RECORD_CORRECT',{...correction,identityConfirmed:true},admin,'2026-10-23T16:05:00Z').state;
  assert.equal(state.visitors[0].name,'Maria homônima');assert.equal(state.visitors[0].identityConfirmedAt,oldConfirmation);assert.equal(state.visitors[0].identityReconfirmedAt,'2026-10-23T16:05:00.000Z');assert.equal(state.visitors[0].identityReconfirmedBy,admin.name);
  state=apply(state,'MASTER_SAVE',{kind:'people',record:{id:saved.result.id,securityStatus:'blocked'}},admin,'2026-10-23T16:06:00Z').state;
  state=apply(state,'RECORD_CORRECT',{kind:'visitor',id,reason:'Registrar acompanhamento',changes:{notes:'Pessoa acompanhada até a saída'}},admin,'2026-10-23T16:07:00Z').state;
  assert.equal(validateState(state).visitors[0].notes,'Pessoa acompanhada até a saída');assert.notEqual(state.visitors[0].personId,oldPersonId);
});

test('migration aditiva preserva JSON legado e banco impede presenças concorrentes',()=>{
  const db=new DatabaseSync(':memory:'),directory=new URL('../drizzle/',import.meta.url),files=readdirSync(directory).filter(f=>f.endsWith('.sql')).sort();
  for(const file of files.filter(f=>f<'0003'))db.exec(readFileSync(new URL(file,directory),'utf8'));
  const body=JSON.stringify({id:'legacy',name:'Pessoa legada',personId:'person',status:'inside',customField:'preservado'});db.prepare('INSERT INTO operational_records(collection,id,body) VALUES (?,?,?)').run('visitors','legacy',body);
  for(const file of files.filter(f=>f>='0003'))db.exec(readFileSync(new URL(file,directory),'utf8'));
  assert.equal(db.prepare('SELECT body FROM operational_records WHERE id=?').get('legacy').body,body);
  assert.equal(db.prepare('SELECT record_person_id FROM operational_records WHERE id=?').get('legacy').record_person_id,'person');
  assert.throws(()=>db.prepare('INSERT INTO operational_records(collection,id,body) VALUES (?,?,?)').run('visitors','concurrent',JSON.stringify({id:'concurrent',personId:'person',status:'inside'})),/UNIQUE constraint failed/);
  db.prepare('UPDATE operational_records SET body=? WHERE id=?').run(JSON.stringify({id:'legacy',personId:'person',status:'completed'}),'legacy');
  assert.doesNotThrow(()=>db.prepare('INSERT INTO operational_records(collection,id,body) VALUES (?,?,?)').run('visitors','next',JSON.stringify({id:'next',personId:'person',status:'inside'})));db.close();
});
