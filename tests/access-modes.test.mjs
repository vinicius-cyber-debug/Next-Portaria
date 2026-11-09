import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,execute,validateState} from '../lib/domain.mjs';
import {accessOverview} from '../lib/physical-access.mjs';
import {canWithCapabilities,defaultCapabilities} from '../lib/access.mjs';
import {windowState} from '../lib/state-sync.ts';
const at='2026-11-09T12:00:00.000Z',later='2026-11-09T13:00:00.000Z',admin={id:'a',name:'Admin de teste',role:'admin'},gate={id:'g',name:'Portaria de teste',role:'gate'};
function fixture(exitControl='controlled'){
 let state=createInitialState();
 const apply=(type,payload,actor=admin,time=at)=>{const result=execute(state,{type,payload,at:time},actor);state=result.state;validateState(state);return result.result;};
 const person=apply('MASTER_SAVE',{kind:'people',record:{name:'Pessoa fictícia',company:'Empresa fictícia',category:'employee',securityStatus:'cleared'}});
 const authorize=()=>apply('PERSON_AUTHORIZE',{personId:person.id,validFrom:at,validUntil:null,areaIds:[null],exitControl,reason:'Permissão conferida para o teste'});
 const enter=(extra={},time=at)=>apply('PERSON_ENTER',{personId:person.id,identityConfirmed:true,...extra},gate,time);
 return {apply,person,authorize,enter,get state(){return state;}};
}
test('cadastro não concede acesso; somente diretoria/admin concede autorização',()=>{
 const f=fixture();assert.throws(()=>f.enter(),{code:'AUTHORIZATION_REQUIRED'});
 const data={personId:f.person.id,validFrom:at,areaIds:[null],exitControl:'controlled',reason:'Teste'};
 for(const role of ['gate','operations','finance','reader'])assert.throws(()=>f.apply('PERSON_AUTHORIZE',data,{...gate,role}),{code:'FORBIDDEN'});
 f.authorize();const visit=f.enter();assert.equal(visit.status,'inside');assert.equal(visit.approvedBy,admin.name);assert.equal(visit.checkedInBy,gate.name);
 assert.throws(()=>f.enter(),{code:'DUPLICATE'});
 assert.ok(f.state.audit.some(a=>a.action==='PERSON_AUTHORIZE'));
});
test('autorização não substitui identidade, segurança, validade, requisitos ou setor',()=>{
 const f=fixture();f.authorize();assert.throws(()=>f.enter({identityConfirmed:false}),{code:'IDENTITY_REQUIRED'});
 assert.throws(()=>f.enter({areaId:'inexistente'}),{code:'NOT_FOUND'});
 f.apply('MASTER_SAVE',{kind:'people',record:{id:f.person.id,securityStatus:'pending'}});
 assert.throws(()=>f.enter(),{code:'SECURITY_PENDING'});
 f.apply('MASTER_SAVE',{kind:'people',record:{id:f.person.id,securityStatus:'cleared'}});
 f.apply('PERSON_AUTH_REVOKE',{personId:f.person.id,reason:'Revogação de teste'});
 assert.throws(()=>f.enter(),{code:'AUTHORIZATION_REQUIRED'});
});
test('portaria não consegue forjar autorização pelo cadastro genérico',()=>{
 const f=fixture();f.apply('MASTER_SAVE',{kind:'people',record:{id:f.person.id,authorization:{status:'active'}}},gate);
 assert.equal(f.state.people[0].authorization,undefined);assert.throws(()=>f.enter(),{code:'AUTHORIZATION_REQUIRED'});
 const user={...gate,status:'active',capabilities:{...defaultCapabilities('gate'),accessManage:true,gateOperate:false}};
 assert.equal(canWithCapabilities(user,'PERSON_AUTHORIZE'),false);assert.equal(canWithCapabilities(user,'PERSON_ENTER'),false);
});
test('saída por barco permanece incerta, separada das presenças e incluída na emergência',()=>{
 const f=fixture('unobserved');f.authorize();const visit=f.enter();assert.equal(visit.status,'unconfirmed');assert.equal(visit.leftAt,null);
 const overview=accessOverview(f.state,later);assert.equal(overview.inside.length,0);assert.equal(overview.unconfirmed.length,1);
 const roll=f.apply('EMERGENCY_START',{},gate,later);assert.equal(roll.people[0].presenceConfidence,'unconfirmed');
 assert.throws(()=>f.enter({},later),{code:'VALIDATION'});
 const next=f.enter({reconciliationReason:'Pessoa se apresentou novamente; saída anterior não observada.'},later);
 assert.notEqual(next.id,visit.id);const previous=f.state.visitors.find(v=>v.id===visit.id);assert.equal(previous.status,'unconfirmed_closed');assert.equal(previous.leftAt,null);assert.equal(previous.reconciledAt,later);
});
test('saída observada encerra registro incerto com horário real do servidor',()=>{
 const f=fixture();f.authorize();const visit=f.enter();
 f.apply('VISITOR_MARK_UNCONFIRMED',{id:visit.id,reason:'Retorno por barco sem controle de saída.'},gate,later);
 const end=f.apply('VISITOR_CHECKOUT',{id:visit.id},gate,'2026-11-09T14:00:00.000Z');assert.equal(end.leftAt,'2026-11-09T14:00:00.000Z');assert.equal(end.status,'completed');
});
test('nova visita individual aprovada também reconcilia saída incerta atomicamente',()=>{
 const f=fixture('unobserved');f.authorize();const previous=f.enter();
 const visit=f.apply('VISITOR_REQUEST',{personId:f.person.id,purpose:'Visita individual',host:'Responsável',expectedAt:later,validUntil:'2026-11-10T13:00:00Z'},gate,later);
 f.apply('VISITOR_APPROVE',{id:visit.id},admin,later);
 assert.throws(()=>f.apply('VISITOR_CHECKIN',{id:visit.id,identityConfirmed:true},gate,later),{code:'VALIDATION'});
 f.apply('VISITOR_CHECKIN',{id:visit.id,identityConfirmed:true,reconciliationReason:'Nova entrada observada após saída sem registro.'},gate,later);
 assert.equal(f.state.visitors.find(v=>v.id===previous.id).leftAt,null);assert.equal(f.state.visitors.find(v=>v.id===previous.id).status,'unconfirmed_closed');
});
test('saída produtiva e retorno sem aprovação adicional preservam histórico e não duplicam entrada',()=>{
 const f=fixture();f.authorize();const visit=f.enter();
 const out=f.apply('EMPLOYEE_LEAVE',{id:visit.id,productionPeriod:'Produção manhã',reason:'Intervalo'},gate,later);
 assert.equal(out.status,'temporarily_out');assert.equal(out.leftAt,null);assert.equal(accessOverview(f.state,later).inside.length,0);
 assert.throws(()=>f.enter({},later),{code:'DUPLICATE'});
 assert.throws(()=>f.apply('EMPLOYEE_LEAVE',{id:visit.id,productionPeriod:'Teste',reason:'Teste'},gate,later),{code:'INVALID_TRANSITION'});
 assert.throws(()=>f.apply('EMPLOYEE_RETURN',{id:visit.id},gate,later),{code:'IDENTITY_REQUIRED'});
 const returned=f.apply('EMPLOYEE_RETURN',{id:visit.id,identityConfirmed:true},gate,'2026-11-09T14:00:00.000Z');
 assert.equal(returned.status,'inside');assert.equal(returned.enteredAt,at);assert.equal(returned.outings[0].returnedBy,gate.name);assert.equal(returned.outings[0].identityConfirmedAt,returned.outings[0].returnedAt);
 assert.throws(()=>f.apply('EMPLOYEE_RETURN',{id:visit.id,identityConfirmed:true},gate,later),{code:'INVALID_TRANSITION'});
});
test('funcionário fora não entra na lista de emergência; bloqueio/revogação impede retorno',()=>{
 const f=fixture();f.authorize();const visit=f.enter();f.apply('EMPLOYEE_LEAVE',{id:visit.id,productionPeriod:'Manhã',reason:'Intervalo'},gate,later);
 assert.equal(f.apply('EMERGENCY_START',{},gate,later).people.length,0);
 f.apply('PERSON_AUTH_REVOKE',{personId:f.person.id,reason:'Desligamento'},admin,later);
 assert.throws(()=>f.apply('EMPLOYEE_RETURN',{id:visit.id,identityConfirmed:true},gate,later),{code:'AUTHORIZATION_REQUIRED'});
});
test('backup rejeita saída inventada, reconciliação sem motivo e histórico produtivo inconsistente',()=>{
 const f=fixture('unobserved');f.authorize();const visit=f.enter();
 const invalid=structuredClone(f.state);invalid.visitors[0].leftAt=later;assert.throws(()=>validateState(invalid),{code:'INVALID_BACKUP'});
 f.enter({reconciliationReason:'Nova entrada observada.'},later);const bad=structuredClone(f.state);bad.visitors.find(v=>v.id===visit.id).reconciliationReason='';assert.throws(()=>validateState(bad),{code:'INVALID_BACKUP'});
 const g=fixture();g.authorize();const present=g.enter();g.apply('EMPLOYEE_LEAVE',{id:present.id,reason:'Intervalo',productionPeriod:'Manhã'},gate,later);
 const badOut=structuredClone(g.state);badOut.visitors[0].outings[0].leftAt='2026-11-09T10:00:00Z';assert.throws(()=>validateState(badOut),{code:'INVALID_BACKUP'});
});
test('presenças incertas e saídas produtivas antigas permanecem na janela operacional',()=>{
 const f=fixture('unobserved');f.authorize();f.enter();assert.equal(windowState(f.state,'2027-03-01T12:00:00Z').visitors.length,1);
});
