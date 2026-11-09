import {assertVisitEligibility,assertNoDuplicatePresence,normalizeVisitAccess,normalizedIdentity} from './physical-access.mjs';

export const MODE_COMMANDS=['PERSON_AUTHORIZE','PERSON_AUTH_REVOKE','PERSON_ENTER','VISITOR_MARK_UNCONFIRMED','EMPLOYEE_LEAVE','EMPLOYEE_RETURN'];
const openStatuses=['inside','unconfirmed','temporarily_out'];
function fail(code,message){throw Object.assign(Error(message),{code});}
function text(value,label,max=1000){if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail('VALIDATION',`${label} é obrigatório (até ${max} caracteres).`);return value.trim();}
function date(value,label){
 const parts=typeof value==='string'?value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i):null;
 if(!parts)fail('VALIDATION',`${label} inválido.`);
 const [,y,m,d,h,min,s,zone]=parts,days=new Date(Date.UTC(+y,+m,0)).getUTCDate();
 if(+m<1||+m>12||+d<1||+d>days||+h>23||+min>59||+(s??0)>59||(!/^z$/i.test(zone)&&(+zone.slice(1,3)>23||+zone.slice(4)>59))||!Number.isFinite(Date.parse(value)))fail('VALIDATION',`${label} inválido.`);
 return new Date(value).toISOString();
}
function find(rows,id){const item=rows.find(r=>r.id===id);if(!item)fail('NOT_FOUND','Cadastro não encontrado.');return item;}
function grant(person,at,areaId){const authorization=person.authorization;if(!authorization||authorization.status!=='active'||Date.parse(at)<Date.parse(authorization.validFrom)||(authorization.validUntil&&Date.parse(at)>Date.parse(authorization.validUntil)))fail('AUTHORIZATION_REQUIRED','A pessoa precisa de autorização prévia vigente.');if(!authorization.areaIds.includes(areaId??null))fail('AREA_PERMISSION_REQUIRED','O setor não está na autorização prévia.');return authorization;}
function gate(payload,state){const value=payload.gateName||state.settings.gateNames[0];if(!state.settings.gateNames.includes(value))fail('VALIDATION','Selecione uma portaria cadastrada.');return value;}

export function reconcileUnconfirmed(state,visit,at,reason){
 const previous=state.visitors.filter(old=>old.id!==visit.id&&old.status==='unconfirmed'&&((visit.personId&&old.personId===visit.personId)||((!visit.personId||!old.personId)&&normalizedIdentity(old.name)===normalizedIdentity(visit.name)&&normalizedIdentity(old.company)===normalizedIdentity(visit.company))));
 if(!previous.length)return;
 reason=text(reason,'Justificativa da reconciliação');
 for(const old of previous){if(Date.parse(at)<Date.parse(old.enteredAt))fail('INVALID_PERIOD','Reconciliação anterior à entrada.');Object.assign(old,{status:'unconfirmed_closed',reconciledAt:at,reconciledBy:visit.checkedInBy,reconciliationReason:reason});}
}

/** Called only by the authenticated, revision-checked domain command pipeline. */
export function executeAccessMode(state,type,payload,at,actor){
 const name=actor.name;
 if(type==='PERSON_AUTHORIZE'||type==='PERSON_AUTH_REVOKE'){
  if(!['admin','director'].includes(actor.role))fail('FORBIDDEN','Somente administrador ou diretoria pode conceder ou revogar autorização prévia.');
  const person=find(state.people,payload.personId),reason=text(payload.reason,'Justificativa');
  if(type==='PERSON_AUTH_REVOKE'){
   if(!person.authorization||person.authorization.status!=='active')fail('INVALID_TRANSITION','Não há autorização ativa.');
   person.authorization={...person.authorization,status:'revoked',revokedAt:at,revokedBy:name,reason};
  }else{
   const validFrom=date(payload.validFrom??at,'Início'),validUntil=payload.validUntil?date(payload.validUntil,'Validade'):null;
   if(validUntil&&(Date.parse(validUntil)<Date.parse(validFrom)||Date.parse(validUntil)<Date.parse(at)))fail('INVALID_PERIOD','A validade deve estar no futuro e após o início.');
   const areaIds=payload.areaIds;
   if(!Array.isArray(areaIds)||!areaIds.length||areaIds.length>100||new Set(areaIds).size!==areaIds.length)fail('VALIDATION','Selecione ao menos um setor, sem repetições.');
   if(!['controlled','unobserved'].includes(payload.exitControl))fail('VALIDATION','Informe o controle de saída.');
   for(const areaId of areaIds){if(areaId===null&&state.accessAreas.some(a=>a.active))fail('VALIDATION','Selecione um setor cadastrado.');if(areaId!==null&&!state.accessAreas.some(a=>a.id===areaId&&a.active))fail('VALIDATION','Setor indisponível.');assertVisitEligibility(state,{personId:person.id,areaId},at);}
   const previous=person.authorization;
   person.authorization={id:crypto.randomUUID(),version:(previous?.version??0)+1,status:'active',validFrom,validUntil,areaIds:[...areaIds],exitControl:payload.exitControl,authorizedAt:at,authorizedBy:name,authorizedById:actor.id??null,reason};
  }
  person.updatedAt=at;person.updatedBy=name;return person;
 }
 if(type==='PERSON_ENTER'){
  const person=find(state.people,payload.personId),access=normalizeVisitAccess(state,{areaId:payload.areaId}),authorization=grant(person,at,access.areaId);
  assertVisitEligibility(state,{personId:person.id,...access},at,{entry:true});
  if(payload.identityConfirmed!==true)fail('IDENTITY_REQUIRED','Confira a identidade antes de cada entrada.');
  const previous=state.visitors.filter(v=>v.personId===person.id&&openStatuses.includes(v.status));
  if(previous.some(v=>v.status!=='unconfirmed'))fail('DUPLICATE','Já existe presença ou saída temporária em aberto.');
  const visit={id:'vis_'+crypto.randomUUID(),personId:person.id,name:person.name,company:text(person.company||'Não informada','Empresa',150),category:person.category,purpose:text(payload.purpose||'Acesso com autorização prévia','Motivo',500),host:authorization.authorizedBy,...access,gateName:gate(payload,state),documentLast4:person.documentLast4||'',notes:'',expectedAt:at,validUntil:authorization.validUntil||new Date(Date.parse(at)+24*3600000).toISOString(),requestedAt:at,requestedBy:name,approvedAt:authorization.authorizedAt,approvedBy:authorization.authorizedBy,authorizationSnapshot:structuredClone(authorization),exitControl:authorization.exitControl,status:authorization.exitControl==='unobserved'?'unconfirmed':'inside',enteredAt:at,leftAt:null,checkedInBy:name,identityConfirmedAt:at,identityConfirmedBy:name};
  reconcileUnconfirmed(state,visit,at,payload.reconciliationReason);
  assertNoDuplicatePresence(state,visit);state.visitors.unshift(visit);return visit;
 }
 const visit=find(state.visitors,payload.id);
 if(type==='VISITOR_MARK_UNCONFIRMED'){
  if(visit.status!=='inside')fail('INVALID_TRANSITION','É necessária uma entrada em aberto.');
  if(Date.parse(at)<Date.parse(visit.enteredAt))fail('INVALID_PERIOD','Registro anterior à entrada.');
  Object.assign(visit,{status:'unconfirmed',exitControl:'unobserved',uncertaintyReason:text(payload.reason,'Justificativa'),uncertaintyRecordedAt:at,uncertaintyRecordedBy:name});return visit;
 }
 const person=find(state.people,visit.personId);
 if(person.category!=='employee')fail('VALIDATION','Saída produtiva é exclusiva de funcionários.');
 if(type==='EMPLOYEE_LEAVE'){
  if(visit.status!=='inside')fail('INVALID_TRANSITION','O funcionário deve estar presente.');
  if(Date.parse(at)<Date.parse(visit.outings?.at(-1)?.returnedAt??visit.enteredAt))fail('INVALID_PERIOD','Saída anterior à última entrada.');
  visit.outings??=[];visit.outings.push({id:crypto.randomUUID(),leftAt:at,leftBy:name,productionPeriod:text(payload.productionPeriod,'Período produtivo',150),reason:text(payload.reason,'Motivo'),returnedAt:null,returnedBy:null});visit.status='temporarily_out';return visit;
 }
 if(type==='EMPLOYEE_RETURN'){
  const outing=visit.outings?.at(-1);
  if(visit.status!=='temporarily_out'||!outing||outing.returnedAt)fail('INVALID_TRANSITION','Não há saída temporária em aberto.');
  if(Date.parse(at)<Date.parse(outing.leftAt))fail('INVALID_PERIOD','Retorno anterior à saída.');
  if(payload.identityConfirmed!==true)fail('IDENTITY_REQUIRED','Confira a identidade no retorno.');
  assertVisitEligibility(state,visit,at,{entry:true});
  if(visit.authorizationSnapshot)grant(person,at,visit.areaId);
  else if(Date.parse(at)>Date.parse(visit.validUntil))fail('OUTSIDE_VALIDITY','Autorização vencida. Solicite novo acesso.');
  assertNoDuplicatePresence(state,visit);Object.assign(outing,{returnedAt:at,returnedBy:name,identityConfirmedAt:at});visit.status='inside';return visit;
 }
 fail('UNKNOWN_COMMAND','Operação desconhecida.');
}

export function validateAccessModes(state){
 for(const person of state.people){
  const a=person.authorization;if(a){
   if(!['active','revoked'].includes(a.status)||!['controlled','unobserved'].includes(a.exitControl)||!Number.isSafeInteger(a.version)||a.version<1||!Array.isArray(a.areaIds)||!a.areaIds.length||new Set(a.areaIds).size!==a.areaIds.length)fail('INVALID_BACKUP','Autorização prévia inválida.');
   text(a.id,'Autorização');date(a.validFrom,'Início');date(a.authorizedAt,'Concessão');text(a.authorizedBy,'Responsável');text(a.reason,'Justificativa');
   if(a.validUntil&&Date.parse(date(a.validUntil,'Validade'))<Date.parse(a.validFrom))fail('INVALID_BACKUP','Validade inconsistente.');
   for(const id of a.areaIds)if(id!==null&&!state.accessAreas.some(area=>area.id===id))fail('INVALID_BACKUP','Setor da autorização ausente.');
   if(a.status==='revoked'){date(a.revokedAt,'Revogação');text(a.revokedBy,'Responsável');}
  }
 }
 const open=new Set();
 for(const visit of state.visitors){
  if(openStatuses.includes(visit.status)&&visit.personId){if(open.has(visit.personId))fail('INVALID_BACKUP','Entradas simultâneas.');open.add(visit.personId);}
  if(['unconfirmed','unconfirmed_closed','temporarily_out'].includes(visit.status)&&visit.leftAt!=null)fail('INVALID_BACKUP','Presença em aberto não deve ter saída definitiva.');
  if(visit.status==='unconfirmed_closed'){date(visit.reconciledAt,'Reconciliação');text(visit.reconciledBy,'Operador');text(visit.reconciliationReason,'Justificativa');if(Date.parse(visit.reconciledAt)<Date.parse(visit.enteredAt))fail('INVALID_BACKUP','Reconciliação anterior à entrada.');}
  let previous=Date.parse(visit.enteredAt),unreturned=0;
  for(const outing of visit.outings??[]){
   if(visit.category!=='employee')fail('INVALID_BACKUP','Saída produtiva sem funcionário.');
   const left=Date.parse(date(outing.leftAt,'Saída temporária'));text(outing.leftBy,'Operador');text(outing.productionPeriod,'Período',150);text(outing.reason,'Motivo');
   if(left<previous||unreturned)fail('INVALID_BACKUP','Saídas temporárias fora de ordem.');
   if(outing.returnedAt){const returned=Date.parse(date(outing.returnedAt,'Retorno'));text(outing.returnedBy,'Operador');if(returned<left||outing.identityConfirmedAt!==outing.returnedAt)fail('INVALID_BACKUP','Retorno inconsistente.');previous=returned;}else{unreturned++;previous=left;}
  }
  if((visit.status==='temporarily_out')!==(unreturned===1)||unreturned>1||(visit.leftAt&&Date.parse(visit.leftAt)<previous))fail('INVALID_BACKUP','Saída produtiva inconsistente.');
 }
 return state;
}
