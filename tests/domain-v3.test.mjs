import test from 'node:test';
import assert from 'node:assert/strict';
import {can,createInitialState,createDemoState,execute,validateState,monthInTimezone,monthlyPreview} from '../lib/domain.mjs';

const admin={id:'admin',name:'Administradora',role:'admin'};
const at='2026-10-23T16:00:00.000Z';
const apply=(state,type,payload={},actor=admin,time=at)=>execute(state,{type,payload,at:time},actor);
const configured=()=>apply(createInitialState(),'SETTINGS_UPDATE',{unitName:'Unidade de teste',timezone:'America/Manaus',gateNames:['Portaria principal']}).state;
function historicalState(){
  const state=createDemoState('2026-09-23T16:00:00.000Z'),stay=state.stays.find(row=>row.status==='completed'),charge=state.charges.find(row=>row.stayId===stay.id);
  const contract={...stay.tariff,id:'contract_legacy',client:stay.client,dueDays:stay.dueDays,validFrom:'2020-01-01T00:00:00Z',validUntil:'2030-01-01T00:00:00Z',active:true,createdAt:stay.start,createdBy:admin.name,updatedAt:stay.start,updatedBy:admin.name};
  state.contracts=[contract];for(const row of [stay,charge])Object.assign(row,{contractId:contract.id,contractVersion:contract.version,contractSnapshot:structuredClone(contract)});
  state.reservations=[{id:'reservation_legacy',vesselName:stay.vesselName,registration:stay.registration,client:stay.client,berth:stay.berth,start:stay.start,end:stay.end,status:'arrived',stayId:stay.id,createdAt:stay.start,createdBy:admin.name,updatedAt:stay.start,updatedBy:admin.name,arrivedAt:stay.start,arrivedBy:admin.name}];stay.reservationId=state.reservations[0].id;
  state.settlements=[{id:'settlement_legacy',...monthlyPreview(state,charge.client,monthInTimezone(charge.createdAt,state.settings.timezone)),createdAt:at,createdBy:admin.name}];return state;
}
const incident={title:'Iluminação do acesso',description:'Uma luminária não acende.',category:'Manutenção',severity:'medium',location:'Portaria principal',responsible:'Manutenção',attachmentIds:['photo_123']};

test('backups v2 recebem coleções novas vazias, mas coleções adulteradas são rejeitadas',()=>{
  const old=configured();for(const kind of ['contracts','reservations','incidents','handovers','settlements'])delete old[kind];
  const restored=validateState(old);assert.deepEqual(restored.contracts,[]);assert.deepEqual(restored.settlements,[]);
  const operated=apply(old,'INCIDENT_CREATE',incident);assert.equal(operated.state.incidents.length,1);assert.equal(old.incidents,undefined);
  const invalid=structuredClone(old);invalid.reservations={};assert.throws(()=>validateState(invalid),{code:'INVALID_BACKUP'});
});

test('restauração de contrato histórico preserva tarifa, versão e prazo da atracação',()=>{
  const state=historicalState(),stay=state.stays.find(row=>row.contractId);assert.doesNotThrow(()=>validateState(state));
  state.contracts[0].version++;state.contracts[0].dailyRateCents+=1000;
  assert.equal(stay.contractVersion,stay.tariff.version);assert.notEqual(stay.tariff.dailyRateCents,state.contracts[0].dailyRateCents);assert.doesNotThrow(()=>validateState(state));
  const tampered=structuredClone(state);tampered.stays.find(row=>row.contractId).contractSnapshot=null;assert.throws(()=>validateState(tampered));
});
test('restauração rejeita snapshot contratado com cliente, vigência ou atividade adulterados',()=>{
  const state=historicalState();
  for(const terms of [{client:'Outro cliente'},{validFrom:at},{active:false},{dueDays:366}]){const forged=structuredClone(state);Object.assign(forged.stays.find(row=>row.contractId).contractSnapshot,terms);assert.throws(()=>validateState(forged));}
});
test('agenda aposentada não permite criar ou cancelar reservas históricas',()=>{
  const state=historicalState(),before=structuredClone(state);
  for(const type of ['RESERVATION_SAVE','RESERVATION_CANCEL'])assert.throws(()=>apply(state,type,{...state.reservations[0],reason:'Teste'}),{code:'MODULE_REMOVED'});
  assert.deepEqual(state,before);
});
test('restauração rejeita previsão anterior ao início e intervalo histórico inválido',()=>{
  const state=historicalState();
  const forgedStay=structuredClone(state);forgedStay.stays[0].plannedEnd='2000-01-01T00:00:00Z';assert.throws(()=>validateState(forgedStay),{code:'INVALID_BACKUP'});
  const forgedReservation=structuredClone(state);forgedReservation.reservations[0].end=forgedReservation.reservations[0].start;assert.throws(()=>validateState(forgedReservation),{code:'INVALID_BACKUP'});
});
test('restauração de chegada histórica exige vínculo recíproco com a reserva e mesmos dados',()=>{
  const state=historicalState();assert.doesNotThrow(()=>validateState(state));
  for(const mutate of [s=>{s.stays.find(row=>row.reservationId).reservationId='inexistente'},s=>{s.reservations[0].registration='OUTRO'},s=>{s.reservations[0].stayId='inexistente'}]){const tampered=structuredClone(state);mutate(tampered);assert.throws(()=>validateState(tampered),{code:'INVALID_BACKUP'});}
});
test('ocorrência preserva histórico, exige solução e justificativa para reabertura',()=>{
  let {state,result:i}=apply(configured(),'INCIDENT_CREATE',incident);
  assert.throws(()=>apply(state,'INCIDENT_UPDATE',{id:i.id,status:'resolved'}),{code:'VALIDATION'});
  state=apply(state,'INCIDENT_UPDATE',{id:i.id,status:'in_progress',note:'Equipe deslocada'}).state;
  state=apply(state,'INCIDENT_UPDATE',{id:i.id,status:'resolved',resolution:'Luminária substituída'}).state;
  assert.throws(()=>apply(state,'INCIDENT_UPDATE',{id:i.id,status:'open'}),{code:'VALIDATION'});
  state=apply(state,'INCIDENT_UPDATE',{id:i.id,status:'open',reason:'Falha voltou a ocorrer'}).state;
  assert.equal(state.incidents[0].history.length,4);assert.equal(state.incidents[0].history[2].note,'Luminária substituída');assert.equal(state.audit[0].reason,'Falha voltou a ocorrer');
  assert.doesNotThrow(()=>validateState(state));const invalid=structuredClone(state);invalid.incidents[0].history.at(-1).status='resolved';assert.throws(()=>validateState(invalid),{code:'INVALID_BACKUP'});
});

test('passagem de turno vincula ocorrências e registra ciência individual uma única vez',()=>{
  let {state,result:i}=apply(configured(),'INCIDENT_CREATE',incident);
  const created=apply(state,'SHIFT_HANDOVER',{shift:'Noite',summary:'Operação regular',pending:'Conferir iluminação',incidentIds:[i.id]});state=created.state;
  const gate={id:'porteiro2',name:'Porteiro da noite',role:'gate'};
  state=apply(state,'SHIFT_ACKNOWLEDGE',{id:created.result.id,note:'Pendência recebida'},gate).state;
  assert.throws(()=>apply(state,'SHIFT_ACKNOWLEDGE',{id:created.result.id},gate),{code:'DUPLICATE'});
  assert.equal(state.handovers[0].acknowledgements[0].actorId,'porteiro2');assert.doesNotThrow(()=>validateState(state));
  assert.throws(()=>apply(state,'SHIFT_HANDOVER',{shift:'Manhã',summary:'Resumo',incidentIds:['inexistente']}),{code:'NOT_FOUND'});
});

test('restauração de fechamento histórico valida mês no fuso, snapshot e totais',()=>{
  assert.equal(monthInTimezone('2026-10-01T02:00:00Z','America/Manaus'),'2026-09');
  const state=historicalState();assert.doesNotThrow(()=>validateState(state));assert.throws(()=>apply(state,'MONTH_CLOSE',{client:state.settlements[0].client,month:'2026-09'}),{code:'MODULE_REMOVED'});
  for(const field of ['totalCents','paidCents','balanceCents']){const invalid=structuredClone(state);invalid.settlements[0][field]++;assert.throws(()=>validateState(invalid),{code:'INVALID_BACKUP'});}
});
test('novos comandos obedecem perfis e todas as alterações produzem auditoria',()=>{
  assert.equal(can('finance','CONTRACT_SAVE'),false);assert.equal(can('finance','MONTH_CLOSE'),false);assert.equal(can('gate','CONTRACT_SAVE'),false);assert.equal(can('gate','RESERVATION_SAVE'),false);assert.equal(can('director','RESERVATION_SAVE'),false);assert.equal(can('reader','SHIFT_ACKNOWLEDGE'),false);
  const {state,result}=apply(configured(),'INCIDENT_CREATE',incident,{id:'gate',name:'Portaria',role:'gate'});
  assert.equal(state.audit[0].entityId,result.id);assert.equal(state.audit[0].changes[0].kind,'incidents');assert.equal(state.audit[0].changes[0].before,null);
});
