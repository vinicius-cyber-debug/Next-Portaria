import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createInitialState,execute,validateState,can} from '../lib/domain.mjs';
import {assertVisitEntry,normalizeAccessArea,personRequirementAlerts} from '../lib/physical-access.mjs';

const at='2026-10-26T16:00:00.000Z',later='2026-10-26T16:00:01.000Z';
const admin={id:'admin',name:'Administradora',role:'admin'},responsible={id:'responsible',name:'Diretora responsável',role:'director'},substitute={id:'substitute',name:'Diretor substituto',role:'director'},other={id:'other',name:'Outra diretora',role:'director'},gate={id:'gate',name:'Porteiro',role:'gate'},operations={id:'operations',name:'Operações',role:'operations'};
const request={name:'Maria Silva',company:'Empresa A',purpose:'Manutenção',host:'Responsável',expectedAt:'2026-10-26T12:00:00Z',validUntil:'2026-10-26T20:00:00Z'};
const apply=(state,type,payload={},actor=admin,time=at)=>execute(state,{type,payload,at:time},actor);
function assigned() {
  const sector=apply(createInitialState(),'ACCESS_AREA_SAVE',{name:'Cais',responsibleUserId:responsible.id,substituteUserId:substitute.id});
  return apply(sector.state,'VISITOR_REQUEST',{...request,areaId:sector.result.id},gate);
}
const requirement=(personId,extra={})=>({personId,name:'Integração da unidade',status:'approved',validUntil:'2026-11-01T16:00:00Z',areaIds:[],notes:'Documentos conferidos',...extra});

test('setor exige responsável distinto do substituto e usa os usuários em novas visitas',()=>{
  assert.throws(()=>normalizeAccessArea({name:'Cais',substituteUserId:'substitute'}),{code:'VALIDATION'});
  assert.throws(()=>normalizeAccessArea({name:'Cais',responsibleUserId:'same',substituteUserId:'same'}),{code:'VALIDATION'});
  const visit=assigned();assert.equal(visit.result.responsibleUserId,responsible.id);assert.equal(visit.result.substituteUserId,substitute.id);
  const changed=apply(visit.state,'ACCESS_AREA_SAVE',{id:visit.result.areaId,responsibleUserId:other.id});
  assert.equal(changed.state.visitors[0].responsibleUserId,responsible.id,'Alterar setor não transfere visitas já solicitadas.');
  assert.equal(changed.result.substituteUserId,substitute.id);
  assert.doesNotThrow(()=>validateState(changed.state));
});

test('portaria usa aprovação do setor e não pode desviar a decisão para outro usuário',()=>{
  const {state,result}=assigned();
  for(const override of [{responsibleUserId:other.id},{substituteUserId:null},{responsibleUserId:null,substituteUserId:null}])assert.throws(()=>apply(state,'VISITOR_REQUEST',{...request,areaId:result.areaId,...override},gate));
  const changed=apply(state,'VISITOR_REQUEST',{...request,areaId:result.areaId,responsibleUserId:other.id,substituteUserId:null},admin);
  assert.equal(changed.result.responsibleUserId,other.id);
});

test('aprovação, recusa e revogação atribuídas aceitam somente responsável, substituto ou administrador',()=>{
  const {state,result}=assigned();
  for(const actor of [responsible,substitute,admin]) {
    assert.equal(apply(state,'VISITOR_APPROVE',{id:result.id},actor).result.status,'authorized');
    assert.equal(apply(state,'VISITOR_REJECT',{id:result.id,reason:'Recusada'},actor).result.status,'denied');
  }
  for(const type of ['VISITOR_APPROVE','VISITOR_REJECT'])assert.throws(()=>apply(state,type,{id:result.id,reason:'Teste'},other),{code:'ASSIGNED_APPROVER_REQUIRED'});
  const approved=apply(state,'VISITOR_APPROVE',{id:result.id},responsible).state;
  assert.throws(()=>apply(approved,'VISITOR_REVOKE',{id:result.id,reason:'Teste'},other),{code:'ASSIGNED_APPROVER_REQUIRED'});
  assert.equal(apply(approved,'VISITOR_REVOKE',{id:result.id,reason:'Cancelamento'},substitute).result.status,'revoked');
  assert.throws(()=>apply(state,'VISITOR_APPROVE',{id:result.id},gate),{code:'FORBIDDEN'});
});

test('visita legada mantém aprovação por perfil e atribuição explícita exige nova autorização',()=>{
  const created=apply(createInitialState(),'VISITOR_REQUEST',request);delete created.result.responsibleUserId;delete created.state.visitors[0].responsibleUserId;delete created.state.visitors[0].substituteUserId;
  const annotation=apply(created.state,'RECORD_CORRECT',{kind:'visitor',id:created.result.id,reason:'Acompanhamento',changes:{notes:'Contato efetuado'}},other);
  assert.equal(Object.hasOwn(annotation.result,'responsibleUserId'),false);assert.equal(Object.hasOwn(annotation.result,'substituteUserId'),false);
  assert.equal(apply(created.state,'VISITOR_APPROVE',{id:created.result.id},other).result.status,'authorized');
  const approved=apply(created.state,'VISITOR_APPROVE',{id:created.result.id},other).state;
  const reassigned=apply(approved,'RECORD_CORRECT',{kind:'visitor',id:created.result.id,reason:'Vincular responsável pelo setor',changes:{responsibleUserId:responsible.id,substituteUserId:substitute.id}});
  assert.equal(reassigned.result.status,'pending');assert.equal(reassigned.result.approvedAt,null);assert.equal(reassigned.result.approvedBy,null);
  assert.equal(reassigned.result.reassignedAt,at);assert.throws(()=>apply(reassigned.state,'VISITOR_APPROVE',{id:created.result.id},other),{code:'ASSIGNED_APPROVER_REQUIRED'});
  assert.doesNotThrow(()=>validateState(reassigned.state));
});

test('alteração de destino aplica novos responsáveis e não altera destino de pessoa presente',()=>{
  const created=assigned(),newArea=apply(created.state,'ACCESS_AREA_SAVE',{name:'Administrativo',responsibleUserId:other.id});
  const approved=apply(newArea.state,'VISITOR_APPROVE',{id:created.result.id},responsible).state;
  const rerouted=apply(approved,'RECORD_CORRECT',{kind:'visitor',id:created.result.id,reason:'Reunião transferida',changes:{areaId:newArea.result.id}});
  assert.equal(rerouted.result.status,'pending');assert.equal(rerouted.result.responsibleUserId,other.id);assert.equal(rerouted.result.substituteUserId,null);
  const reapproved=apply(rerouted.state,'VISITOR_APPROVE',{id:created.result.id},other).state;
  const inside=apply(reapproved,'VISITOR_CHECKIN',{id:created.result.id,identityConfirmed:true},gate).state;
  assert.throws(()=>apply(inside,'RECORD_CORRECT',{kind:'visitor',id:created.result.id,reason:'Troca',changes:{responsibleUserId:responsible.id}}),{code:'INVALID_TRANSITION'});
});

test('requisito registra conferência confiável, referências e auditoria, sem duplicar cadastro',()=>{
  const created=assigned(),personId=created.result.personId;
  const saved=apply(created.state,'PERSON_REQUIREMENT_SAVE',{...requirement(personId),reviewedAt:'2020-01-01T00:00:00Z',reviewedBy:'forjado',reviewedByUserId:'forjado'},operations);
  assert.equal(saved.result.reviewedAt,at);assert.equal(saved.result.reviewedBy,operations.name);assert.equal(saved.result.reviewedByUserId,operations.id);
  assert.equal(saved.state.audit[0].action,'PERSON_REQUIREMENT_SAVE');assert.equal(saved.state.audit[0].changes[0].kind,'personRequirements');
  assert.throws(()=>apply(saved.state,'PERSON_REQUIREMENT_SAVE',requirement(personId)),{code:'DUPLICATE'});
  const otherPerson=apply(saved.state,'MASTER_SAVE',{kind:'people',record:{name:'Outra pessoa'}});
  assert.throws(()=>apply(otherPerson.state,'PERSON_REQUIREMENT_SAVE',{id:saved.result.id,personId:otherPerson.result.id}),{code:'VALIDATION'});
  assert.throws(()=>apply(saved.state,'PERSON_REQUIREMENT_SAVE',requirement('missing')),{code:'NOT_FOUND'});
  assert.throws(()=>apply(saved.state,'PERSON_REQUIREMENT_SAVE',requirement(personId,{name:'Outro requisito',areaIds:['missing']})),{code:'NOT_FOUND'});
  assert.doesNotThrow(()=>validateState(saved.state));
});

test('requisitos explícitos bloqueiam aprovação e entrada no instante do vencimento',()=>{
  const created=assigned(),personId=created.result.personId,id=created.result.id;
  const saved=apply(created.state,'PERSON_REQUIREMENT_SAVE',requirement(personId,{validUntil:later}));
  const approved=apply(saved.state,'VISITOR_APPROVE',{id},responsible);
  assert.throws(()=>apply(saved.state,'VISITOR_APPROVE',{id},responsible,later),{code:'REQUIREMENT_EXPIRED'});
  assert.throws(()=>apply(approved.state,'VISITOR_CHECKIN',{id,identityConfirmed:true},gate,later),{code:'REQUIREMENT_EXPIRED'});
  assert.throws(()=>assertVisitEntry(approved.state,approved.result,{identityConfirmed:true},later,gate),{code:'REQUIREMENT_EXPIRED'});
  assert.equal(apply(approved.state,'VISITOR_CHECKIN',{id,identityConfirmed:true},gate).result.status,'inside');
  assert.throws(()=>apply(created.state,'PERSON_REQUIREMENT_SAVE',requirement(personId,{validUntil:at})),{code:'REQUIREMENT_EXPIRED'});
  assert.throws(()=>apply(created.state,'PERSON_REQUIREMENT_SAVE',requirement(personId,{validUntil:null})),{code:'VALIDATION'});
});

test('requisito pendente ou revogado invalida credencial e preserva presenças em andamento',()=>{
  const created=assigned(),id=created.result.id,personId=created.result.personId;
  const saved=apply(created.state,'PERSON_REQUIREMENT_SAVE',requirement(personId)),approved=apply(saved.state,'VISITOR_APPROVE',{id},responsible);
  for(const status of ['pending','revoked']) {
    const blocked=apply(approved.state,'PERSON_REQUIREMENT_SAVE',{id:saved.result.id,status},operations);
    assert.equal(blocked.state.visitors[0].status,'revoked');assert.equal(blocked.state.visitors[0].revokedBy,operations.name);
    const newVisit=apply(blocked.state,'VISITOR_REQUEST',{...request,personId,areaId:created.result.areaId});
    assert.throws(()=>apply(newVisit.state,'VISITOR_APPROVE',{id:newVisit.result.id},responsible),{code:'REQUIREMENT_PENDING'});
  }
  const inside=apply(approved.state,'VISITOR_CHECKIN',{id,identityConfirmed:true},gate),revoked=apply(inside.state,'PERSON_REQUIREMENT_SAVE',{id:saved.result.id,status:'revoked'});
  assert.equal(revoked.state.visitors[0].status,'inside');assert.equal(apply(revoked.state,'VISITOR_CHECKOUT',{id},gate).result.status,'completed');
});

test('validade e bloqueio respeitam escopo de setor e não criam requisitos implícitos',()=>{
  const created=assigned(),otherArea=apply(created.state,'ACCESS_AREA_SAVE',{name:'Escritório'}),id=created.result.id;
  const scoped=apply(otherArea.state,'PERSON_REQUIREMENT_SAVE',requirement(created.result.personId,{status:'pending',validUntil:null,areaIds:[otherArea.result.id]}));
  assert.equal(apply(scoped.state,'VISITOR_APPROVE',{id},responsible).result.status,'authorized');
  const otherVisit=apply(scoped.state,'VISITOR_REQUEST',{...request,personId:created.result.personId,areaId:otherArea.result.id});
  assert.throws(()=>apply(otherVisit.state,'VISITOR_APPROVE',{id:otherVisit.result.id}),{code:'REQUIREMENT_PENDING'});
  const fresh=apply(createInitialState(),'VISITOR_REQUEST',request);assert.equal(apply(fresh.state,'VISITOR_APPROVE',{id:fresh.result.id}).result.status,'authorized');
});

test('alertas distinguem vencido, a vencer, pendente e revogado com relógio definido',()=>{
  const created=assigned(),personId=created.result.personId;let state=created.state;
  for(const [name,status,validUntil] of [['Recente','approved','2026-10-27T16:00:00Z'],['Longo','approved','2027-10-26T16:00:00Z'],['Pendente','pending',null],['Revogado','revoked',null]])state=apply(state,'PERSON_REQUIREMENT_SAVE',requirement(personId,{name,status,validUntil})).state;
  assert.deepEqual(personRequirementAlerts(state,at).map(r=>r.alertStatus).sort(),['expiring','pending','revoked']);
  const expired=personRequirementAlerts(state,'2026-10-27T16:00:00Z').find(r=>r.name==='Recente');assert.equal(expired.alertStatus,'expired');assert.equal(expired.personName,'Maria Silva');
});

test('restauração aceita histórico vencido e rejeita referências, responsáveis e datas adulteradas',()=>{
  const created=assigned(),saved=apply(created.state,'PERSON_REQUIREMENT_SAVE',requirement(created.result.personId,{validUntil:later}));
  assert.doesNotThrow(()=>validateState(saved.state));
  const legacy=structuredClone(created.state);delete legacy.personRequirements;assert.deepEqual(validateState(legacy).personRequirements,[]);
  for(const mutation of [s=>s.personRequirements[0].personId='missing',s=>s.personRequirements[0].areaIds=['missing'],s=>s.personRequirements[0].reviewedAt='2026-10-25T16:00:00Z',s=>s.personRequirements[0].validUntil=null,s=>s.personRequirements[0].validUntil='2026-10-26T15:59:59Z',s=>s.accessAreas[0].substituteUserId=s.accessAreas[0].responsibleUserId,s=>s.visitors[0].substituteUserId=s.visitors[0].responsibleUserId]) {
    const tampered=structuredClone(saved.state);mutation(tampered);assert.throws(()=>validateState(tampered),{code:'INVALID_BACKUP'});
  }
});

test('perfis sem gestão não mantêm requisitos e migration preserva dados e exige troca de senha inicial',()=>{
  for(const role of ['reader','gate','finance'])assert.equal(can(role,'PERSON_REQUIREMENT_SAVE'),false);
  for(const role of ['admin','director','operations'])assert.equal(can(role,'PERSON_REQUIREMENT_SAVE'),true);
  const db=new DatabaseSync(':memory:'),directory=new URL('../drizzle/',import.meta.url),files=readdirSync(directory).filter(f=>f.endsWith('.sql')).sort();
  for(const file of files.filter(f=>f<'0004'))db.exec(readFileSync(new URL(file,directory),'utf8'));
  db.prepare('INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('legacy','legacy@example.test','Usuário legado','admin','active',at,at);
  db.prepare('INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_changed_at) VALUES (?,?,?,?,?)').run('legacy','legacy','salt','hash',at);
  const body=JSON.stringify({id:'v',responsibleUserId:responsible.id,validUntil:later,updatedAt:at,custom:'preservado'});db.prepare('INSERT INTO operational_records(collection,id,body) VALUES (?,?,?)').run('visitors','v',body);
  db.exec(readFileSync(new URL('0004_v5.sql',directory),'utf8'));
  assert.equal(db.prepare('SELECT must_change_password FROM operational_credentials').get().must_change_password,1);
  const record=db.prepare('SELECT * FROM operational_records').get();assert.equal(record.body,body);assert.equal(record.record_responsible_user_id,responsible.id);assert.equal(record.record_valid_until,later);
  db.prepare('INSERT INTO operational_changes(revision,created_at,body) VALUES (?,?,?)').run(1,at,JSON.stringify({collections:{},values:{}}));
  assert.throws(()=>db.prepare('INSERT INTO operational_changes(revision,created_at,body) VALUES (?,?,?)').run(2,at,'invalid'),/CHECK constraint failed/);db.close();
});
