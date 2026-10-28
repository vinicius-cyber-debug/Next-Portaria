import test from 'node:test';
import assert from 'node:assert/strict';
import {can,calculateCharge,createInitialState,createDemoState,execute,validateState} from '../lib/domain.mjs';

const admin={id:'admin',name:'Administradora',role:'admin'};
const at='2026-10-22T16:00:00.000Z';
const apply=(state,type,payload={},actor=admin,time=at)=>execute(state,{type,payload,at:time},actor);
const configured=()=>apply(createInitialState(),'SETTINGS_UPDATE',{unitName:'Unidade de teste',timezone:'America/Manaus',gateNames:['Portaria principal']}).state;
const request={name:'Visitante',company:'Empresa',host:'Responsável',purpose:'Manutenção',expectedAt:'2026-10-22T14:00:00Z',validUntil:'2026-10-22T20:00:00Z'};
const open={vesselName:'Embarcação',registration:'ABC123',client:'Empresa',berth:'Berço 1',start:'2026-10-21T16:00:00Z'};
function chargeState(){return createDemoState(at);}

test('base real inicia vazia; demonstração histórica nunca é implícita',()=>{
  const state=createInitialState();assert.equal(state.version,2);assert.equal(state.visitors.length+state.stays.length+state.charges.length+state.audit.length,0);assert.equal(state.settings.configured,false);
  assert.throws(()=>apply(state,'STAY_OPEN',open),{code:'MODULE_REMOVED'});assert.ok(createDemoState(at).stays.length>0);
});
test('diária iniciada respeita limite de 24h, tolerância única e fração de segundo',()=>{
  const tariff={dailyRateCents:10000,toleranceMinutes:10};const start='2026-10-20T00:00:00Z';
  assert.equal(calculateCharge(start,start,tariff).totalCents,0);
  assert.equal(calculateCharge(start,'2026-10-20T00:10:00Z',tariff).units,0);
  assert.equal(calculateCharge(start,'2026-10-20T00:10:00.001Z',tariff).units,1);
  assert.equal(calculateCharge(start,'2026-10-21T00:10:00Z',tariff).units,1);
  assert.equal(calculateCharge(start,'2026-10-21T00:10:00.001Z',tariff).units,2);
  assert.equal(calculateCharge(start,'2026-10-22T00:00:00Z',tariff).units,2);
  assert.throws(()=>calculateCharge(start,'2026-10-19T00:00:00Z',tariff),{code:'INVALID_PERIOD'});
});
test('datas impossíveis e instantes sem fuso são recusados',()=>{
  const tariff={dailyRateCents:10000};for(const value of ['2026-02-30T10:00:00Z','2026-10-22T24:00:00Z','2026-10-22T10:00:00','2026-10-22T10:60:00Z']) assert.throws(()=>calculateCharge(value,at,tariff),{code:'VALIDATION'});
});
test('perfis e subtipos limitam operações sensíveis',()=>{
  assert.equal(can('reader','READ'),true);assert.equal(can('reader','STAY_OPEN'),false);assert.equal(can('ops','STAY_OPEN'),false);assert.equal(can('gate','VISITOR_APPROVE'),false);
  assert.throws(()=>apply(configured(),'MASTER_SAVE',{kind:'vessels',record:{name:'Barco',registration:'A'}},{name:'Porteiro',role:'gate'}),{code:'MODULE_REMOVED'});
  assert.throws(()=>apply(configured(),'SETTINGS_UPDATE',{unitName:'Troca indevida'},{name:'Financeiro',role:'finance'}),{code:'FORBIDDEN'});
});
test('visita exige aprovação válida, permite saída e rejeita transição repetida',()=>{
  let {state,result}=apply(configured(),'VISITOR_REQUEST',request);const id=result.id;
  assert.throws(()=>apply(state,'VISITOR_CHECKIN',{id,identityConfirmed:true}),{code:'INVALID_TRANSITION'});
  state=apply(state,'VISITOR_APPROVE',{id}).state;
  assert.throws(()=>apply(state,'VISITOR_CHECKIN',{id,identityConfirmed:true},admin,'2026-10-22T21:00:00Z'),{code:'OUTSIDE_VALIDITY'});
  state=apply(state,'VISITOR_CHECKIN',{id,identityConfirmed:true}).state;state=apply(state,'VISITOR_CHECKOUT',{id}).state;
  assert.equal(state.visitors[0].status,'completed');assert.throws(()=>apply(state,'VISITOR_CHECKOUT',{id}),{code:'INVALID_TRANSITION'});
});
test('revogação e cancelamento registram justificativa e bloqueiam a entrada',()=>{
  let {state,result}=apply(configured(),'VISITOR_REQUEST',request);state=apply(state,'VISITOR_APPROVE',{id:result.id}).state;
  assert.throws(()=>apply(state,'VISITOR_REVOKE',{id:result.id}),{code:'VALIDATION'});
  state=apply(state,'VISITOR_REVOKE',{id:result.id,reason:'Solicitação cancelada pela empresa'}).state;
  assert.equal(state.audit[0].reason,'Solicitação cancelada pela empresa');assert.equal(state.audit[0].changes[0].before.status,'authorized');assert.equal(state.audit[0].changes[0].after.status,'revoked');
  assert.throws(()=>apply(state,'VISITOR_CHECKIN',{id:result.id,identityConfirmed:true}),{code:'INVALID_TRANSITION'});
});
test('cadastro inativo não pode originar novo acesso; a mesma pessoa não entra duas vezes',()=>{
  let {state,result:person}=apply(configured(),'MASTER_SAVE',{kind:'people',record:{name:'Maria',active:false}});
  assert.throws(()=>apply(state,'VISITOR_REQUEST',{...request,personId:person.id}),{code:'INACTIVE_MASTER'});
  state=apply(state,'MASTER_SAVE',{kind:'people',record:{...person,active:true}}).state;
  let first=apply(state,'VISITOR_REQUEST',{...request,personId:person.id});state=first.state;state=apply(state,'VISITOR_APPROVE',{id:first.result.id}).state;state=apply(state,'VISITOR_CHECKIN',{id:first.result.id,identityConfirmed:true}).state;
  let second=apply(state,'VISITOR_REQUEST',{...request,personId:person.id});state=apply(second.state,'VISITOR_APPROVE',{id:second.result.id}).state;
  assert.throws(()=>apply(state,'VISITOR_CHECKIN',{id:second.result.id,identityConfirmed:true}),{code:'DUPLICATE'});
});
test('veículo vinculado não registra entrada de pessoa automaticamente',()=>{
  let visitor=apply(configured(),'VISITOR_REQUEST',request);let state=apply(visitor.state,'VISITOR_APPROVE',{id:visitor.result.id}).state;
  state=apply(state,'VEHICLE_ENTER',{plate:'ABC1D23',driver:'João',company:'Empresa',purpose:'Entrega',visitorId:visitor.result.id}).state;
  assert.equal(state.visitors[0].status,'authorized');assert.throws(()=>apply(state,'VEHICLE_ENTER',{plate:'ABC-1D23',driver:'João',company:'Empresa',purpose:'Entrega'}),{code:'DUPLICATE'});
});
test('atracações e alterações tarifárias aposentadas não modificam o histórico',()=>{
  const state=chargeState(),before=structuredClone(state);
  for(const [type,payload] of [['STAY_OPEN',open],['STAY_CLOSE',{id:state.stays[0].id}],['SETTINGS_UPDATE',{dailyRateCents:30000}]])assert.throws(()=>apply(state,type,payload),{code:'MODULE_REMOVED'});
  assert.deepEqual(state,before);assert.doesNotThrow(()=>validateState(state));
});test('recebimentos, estornos e cancelamentos aposentados preservam o saldo histórico',()=>{
  const state=chargeState(),before=structuredClone(state),id=state.charges[0].id;
  for(const [type,payload] of [['CHARGE_PAYMENT',{id,amountCents:1000,method:'pix'}],['PAYMENT_REVERSE',{chargeId:id,paymentId:'payment_legacy',reason:'Teste'}],['CHARGE_CANCEL',{id,reason:'Teste'}]])assert.throws(()=>apply(state,type,payload),{code:'MODULE_REMOVED'});
  assert.deepEqual(state,before);assert.doesNotThrow(()=>validateState(state));
});test('correção de visita preserva horários, produz antes e depois e não altera o estado recebido',()=>{
  const created=apply(configured(),'VISITOR_REQUEST',request),state=created.state,copy=structuredClone(state),id=created.result.id;
  assert.throws(()=>apply(state,'RECORD_CORRECT',{kind:'visitor',id,reason:'Erro',changes:{expectedAt:at}}),{code:'VALIDATION'});
  const next=apply(state,'RECORD_CORRECT',{kind:'visitor',id,reason:'Complementar registro',changes:{notes:'Conferido pela portaria'}}).state;
  assert.deepEqual(state,copy);assert.equal(next.visitors[0].notes,'Conferido pela portaria');assert.equal(next.audit[0].changes[0].before.notes,'');assert.equal(next.visitors[0].expectedAt,state.visitors[0].expectedAt);
});
test('correção de pessoa presente preserva unicidade sem confundir nomes iguais',()=>{
  let state=configured();const people=[];
  for(const name of ['Pessoa A','Pessoa B']){const person=apply(state,'MASTER_SAVE',{kind:'people',record:{name}});state=person.state;people.push(person.result);}
  const visits=[];
  for(const person of people){const visit=apply(state,'VISITOR_REQUEST',{...request,name:'Mesmo nome',documentLast4:'1234',personId:person.id});state=apply(visit.state,'VISITOR_APPROVE',{id:visit.result.id}).state;state=apply(state,'VISITOR_CHECKIN',{id:visit.result.id,identityConfirmed:true}).state;visits.push(visit.result);}
  assert.equal(validateState(state).visitors.filter(v=>v.status==='inside').length,2);
  for(const personId of [people[0].id,` ${people[0].id} `])assert.throws(()=>apply(state,'RECORD_CORRECT',{kind:'visitor',id:visits[1].id,reason:'Corrigir vínculo da pessoa',changes:{personId},identityConfirmed:true}),{code:'DUPLICATE'});
  const forged=structuredClone(state);forged.visitors[0].personId=people[0].id;assert.throws(()=>validateState(forged),{code:'INVALID_BACKUP'});
  state=apply(state,'VISITOR_CHECKOUT',{id:visits[0].id}).state;
  state=apply(state,'RECORD_CORRECT',{kind:'visitor',id:visits[1].id,reason:'Corrigir vínculo após saída',changes:{personId:people[0].id},identityConfirmed:true}).state;
  assert.equal(validateState(state).visitors.find(v=>v.id===visits[1].id).personId,people[0].id);
});

test('responsável financeiro histórico não pode ser corrigido após aposentadoria do módulo',()=>{
  const state=chargeState(),id=state.stays[0].id;
  assert.throws(()=>apply(state,'RECORD_CORRECT',{kind:'stay',id,reason:'Troca de pagador',changes:{client:'Outro pagador'}}),{code:'MODULE_REMOVED'});
  const forged=structuredClone(state);forged.charges[0].client='Outro pagador';assert.throws(()=>validateState(forged),{code:'INVALID_BACKUP'});
});test('cadastro de berços aposentado rejeita inclusão e remoção sem alterar o histórico',()=>{
  const state=chargeState(),before=structuredClone(state);
  for(const type of ['BERTH_ADD','BERTH_REMOVE'])assert.throws(()=>apply(state,type,{name:state.berths[0]}),{code:'MODULE_REMOVED'});
  assert.deepEqual(state,before);
});
test('cadastro e correção de embarcações aposentados são recusados',()=>{
  const state=chargeState();
  assert.throws(()=>apply(state,'MASTER_SAVE',{kind:'vessels',record:{name:'Barco',registration:'LEGADO'}}),{code:'MODULE_REMOVED'});
  assert.throws(()=>apply(state,'RECORD_CORRECT',{kind:'stay',id:state.stays[0].id,reason:'Corrigir vínculo',changes:{vesselId:'vessel_legacy'}}),{code:'MODULE_REMOVED'});
});
test('restauração rejeita objetos em campos de exibição e identificadores não canônicos',()=>{
  let state=chargeState();
  const charge=state.charges[0];charge.payments=[{id:'payment_legacy',amountCents:1000,method:'pix',reference:'Comprovante histórico',receivedAt:at,registeredAt:at,registeredBy:'Administradora',reversedAt:null}];charge.paidCents=1000;charge.balanceCents=charge.totalCents-1000;charge.status='partial';
  state=apply(state,'MASTER_SAVE',{kind:'people',record:{name:'Pessoa'}}).state;
  state=apply(state,'MASTER_SAVE',{kind:'fleet',record:{plate:'ABC1D23'}}).state;
  state=apply(state,'VISITOR_REQUEST',{...request,personId:` ${state.people[0].id} `}).state;assert.equal(state.visitors[0].personId,state.people[0].id);
  state=apply(state,'VISITOR_APPROVE',{id:state.visitors[0].id}).state;
  state=apply(state,'VEHICLE_ENTER',{plate:'ABC1D23',driver:'Motorista',company:'Empresa',purpose:'Entrega',visitorId:` ${state.visitors[0].id} `,fleetId:` ${state.fleet[0].id} `}).state;
  assert.equal(state.vehicles[0].visitorId,state.visitors[0].id);assert.equal(state.vehicles[0].fleetId,state.fleet[0].id);assert.doesNotThrow(()=>validateState(state));assert.doesNotThrow(()=>validateState(createDemoState(at)));
  const mutations=[
    s=>{s.charges[0].client={name:'Inválido'}},s=>{s.charges[0].vesselName=[]},s=>{s.stays[0].berth={name:'Inválido'}},
    s=>{s.people[0].contact={phone:'Inválido'}},s=>{s.fleet[0].name={description:'Inválida'}},s=>{s.stays[0].notes={text:'Inválido'}},
    s=>{s.vehicles[0].plate=12345},s=>{s.visitors[0].documentLast4=1234},s=>{s.charges[0].payments[0].reference={code:'Inválido'}},
    s=>{s.stays[0].id=` ${s.stays[0].id} `},
  ];
  for(const mutate of mutations){const forged=structuredClone(state);mutate(forged);assert.throws(()=>validateState(forged));}
});
test('restauração valida relações, cálculo, saldo e não importa auditoria externa',()=>{
  const valid=chargeState();assert.equal(validateState(valid).audit.length,0);
  const forged=structuredClone(valid);forged.charges[0].totalCents++;assert.throws(()=>validateState(forged),{code:'INVALID_BACKUP'});
  const missing=structuredClone(valid);missing.charges=[];assert.throws(()=>validateState(missing),{code:'INVALID_BACKUP'});
  const duplicate=structuredClone(valid);duplicate.stays.push(structuredClone(duplicate.stays[0]));assert.throws(()=>validateState(duplicate),{code:'INVALID_BACKUP'});
});
