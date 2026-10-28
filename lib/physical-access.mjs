/** Regras de acesso físico: sem relógio, identidade ou persistência fornecidos pelo navegador. */
import { moduleRemoved } from './module-policy.mjs';
export const PERSON_CATEGORIES = ['employee','visitor','supplier','contractor','driver'];
const HISTORICAL_PERSON_CATEGORIES = [...PERSON_CATEGORIES,'crew'];
export const SECURITY_STATUSES = ['cleared','pending','blocked'];
export const ACCESS_COLLECTIONS = ['accessAreas','crewManifests','emergencyRollCalls','accessCorrections','personRequirements'];
function fail(code,message) { const error=new Error(message);error.code=code;throw error; }
function text(value,label,max=150,required=true) {
  if(value==null||value==='') {if(required)fail('VALIDATION',`${label} é obrigatório.`);return '';}
  if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail('VALIDATION',`${label} inválido.`);
  return value.trim();
}
function boolean(value,label) {if(typeof value!=='boolean')fail('VALIDATION',`${label} inválido.`);return value;}
function ids(value,label,max=500) {if(!Array.isArray(value)||value.length>max)fail('VALIDATION',`${label} inválido.`);const answer=value.map(v=>text(v,label));if(new Set(answer).size!==answer.length)fail('DUPLICATE',`${label} contém referências repetidas.`);return answer;}
function instant(value,label) {
  const match=typeof value==='string'?value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i):null;
  if(!match)fail('VALIDATION',`${label} deve conter data, hora e fuso válidos.`);
  const [,y,m,d,h,min,s,,]=match,days=new Date(Date.UTC(+y,+m,0)).getUTCDate();
  if(+m<1||+m>12||+d<1||+d>days||+h>23||+min>59||+(s??0)>59||!Number.isFinite(Date.parse(value)))fail('VALIDATION',`${label} inválido.`);
  return new Date(value).toISOString();
}
function find(items,id,label) {const value=(items??[]).find(r=>r.id===text(id,label));if(!value)fail('NOT_FOUND',`${label} não encontrado.`);return value;}
export function normalizedIdentity(value='') {return String(value).trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').toUpperCase();}
export function personIdentityKey(person) {return JSON.stringify([normalizedIdentity(person.name),normalizedIdentity(person.company),person.documentLast4??'']);}
export function normalizePersonAccess(payload,current={},{historical=false}={}) {
  const category=payload.category??current.category??'visitor';if(!HISTORICAL_PERSON_CATEGORIES.includes(category))fail('VALIDATION','Categoria de pessoa inválida.');
  if(category==='crew'&&!historical&&current.category!=='crew')moduleRemoved();
  const contractorChanged=category==='contractor'&&current.category!=='contractor';
  const securityStatus=payload.securityStatus??(contractorChanged?'pending':current.securityStatus??'cleared');if(!SECURITY_STATUSES.includes(securityStatus))fail('VALIDATION','Situação de segurança inválida.');
  const documentLast4=text(payload.documentLast4??current.documentLast4,'Final do documento',4,false);if(documentLast4&&!/^\d{4}$/.test(documentLast4))fail('VALIDATION','Informe somente os quatro últimos dígitos do documento.');
  return {category,securityStatus,documentLast4,restrictions:text(payload.restrictions??current.restrictions,'Restrições',2000,false),allowedAreaIds:ids(payload.allowedAreaIds??current.allowedAreaIds??[],'Áreas permitidas',100)};
}
export function normalizeVisitResponsibility(payload,current={}) {
  const responsibleUserId=text(Object.hasOwn(payload,'responsibleUserId')?payload.responsibleUserId:current.responsibleUserId,'Usuário responsável',150,false)||null;
  const substituteUserId=text(Object.hasOwn(payload,'substituteUserId')?payload.substituteUserId:current.substituteUserId,'Usuário substituto',150,false)||null;
  if(substituteUserId&&!responsibleUserId)fail('VALIDATION','Selecione o responsável antes de informar um substituto.');
  if(responsibleUserId&&responsibleUserId===substituteUserId)fail('VALIDATION','O substituto deve ser outro usuário.');
  return {responsibleUserId,substituteUserId};
}
export function normalizeAccessArea(payload,current={}) {return {name:text(payload.name??current.name,'Setor de destino'),restricted:boolean(payload.restricted??current.restricted??false,'Área restrita'),active:boolean(payload.active??current.active??true,'Situação do setor'),...normalizeVisitResponsibility(payload,current)};}
export function normalizeVisitAccess(state,payload,current={}) {
  const areaId=text(payload.areaId??current.areaId,'Setor de destino',150,false)||null;
  let area;if(areaId) {area=find(state.accessAreas,areaId,'Setor de destino');if(!area.active)fail('INACTIVE_MASTER','O setor está inativo.');}
  else if((state.accessAreas??[]).some(a=>a.active))fail('VALIDATION','Selecione o setor de destino.');
  const stayId=text(payload.stayId??current.stayId,'Atracação',150,false)||null;if(stayId)find(state.stays,stayId,'Atracação');
  const responsibility=normalizeVisitResponsibility(payload,current.id?current:area??{});
  if(area?.responsibleUserId&&!responsibility.responsibleUserId)fail('RESPONSIBLE_REQUIRED','Selecione o usuário responsável pela aprovação.');
  return {areaId,stayId,...responsibility};
}
/** A identidade do ator e o perfil são fornecidos exclusivamente pelo servidor. */
export function assertVisitDecisionAuthority(visit,actor) {
  if(actor.role==='admin')return;
  if(visit.responsibleUserId&&![visit.responsibleUserId,visit.substituteUserId].includes(actor.id))fail('ASSIGNED_APPROVER_REQUIRED','A decisão cabe ao responsável indicado, ao substituto ou ao administrador.');
}
export function normalizePersonRequirement(state,payload,at,actor,current={},{historical=false}={}) {
  const personId=text(payload.personId??current.personId,'Pessoa do requisito');find(state.people,personId,'Pessoa do requisito');
  if(current.personId&&current.personId!==personId)fail('VALIDATION','Preserve a pessoa vinculada ao requisito.');
  const name=text(payload.name??current.name,'Requisito de segurança',150),status=payload.status??current.status??'pending';
  if(!['approved','pending','revoked'].includes(status))fail('VALIDATION','Situação do requisito inválida.');
  const value=Object.hasOwn(payload,'validUntil')?payload.validUntil:current.validUntil,validUntil=value?instant(value,'Validade do requisito'):null;
  if(status==='approved'&&!validUntil)fail('VALIDATION','Informe a validade do requisito aprovado.');
  if(status==='approved'&&Date.parse(validUntil)<=Date.parse(at))fail('REQUIREMENT_EXPIRED',historical?'A conferência do requisito deve preceder seu vencimento.':'A validade do requisito aprovado deve estar no futuro.');
  const areaIds=ids(payload.areaIds??current.areaIds??[],'Setores do requisito',100);for(const areaId of areaIds)find(state.accessAreas,areaId,'Setor do requisito');
  return {personId,name,status,validUntil,areaIds,notes:text(payload.notes??current.notes,'Observações do requisito',2000,false),reviewedAt:at,reviewedBy:text(actor.name,'Responsável pela conferência'),reviewedByUserId:text(actor.id,'Usuário da conferência',150,false)||null,createdAt:current.createdAt??at,createdBy:current.createdBy??actor.name,updatedAt:at,updatedBy:actor.name};
}
export function personRequirementAlerts(state,at=new Date().toISOString(),{warningDays=30}={}) {
  const now=Date.parse(instant(at,'Data dos requisitos')),warningUntil=now+warningDays*86400000;
  return (state.personRequirements??[]).flatMap(requirement=>{
    const until=requirement.validUntil?Date.parse(requirement.validUntil):null;
    const alertStatus=requirement.status==='pending'?'pending':requirement.status==='revoked'?'revoked':until<=now?'expired':until<=warningUntil?'expiring':null;
    if(!alertStatus)return [];
    const person=state.people?.find(p=>p.id===requirement.personId);
    return [{...requirement,alertStatus,personName:person?.name??'Pessoa não encontrada'}];
  });
}
/** Executada também na aprovação: autorização nunca substitui elegibilidade atual. */
export function assertVisitEligibility(state,visit,at,{entry=false}={}) {
  if(visit.stayId||visit.destinationType==='vessel'||visit.category==='crew')moduleRemoved();
  const person=visit.personId?find(state.people,visit.personId,'Pessoa'):null;
  if(person?.category==='crew')moduleRemoved();
  if(person) {
    if(person.active!==true)fail('INACTIVE_MASTER','Pessoa inativa. Revise o cadastro antes de liberar o acesso.');
    if(person.securityStatus==='blocked')fail('ACCESS_BLOCKED','Pessoa bloqueada pela segurança.');
    if(person.securityStatus==='pending')fail('SECURITY_PENDING','A pessoa possui requisito de segurança pendente. Solicite validação do responsável.');
    for(const requirement of state.personRequirements??[]) {
      if(requirement.personId!==person.id||requirement.areaIds?.length&&!requirement.areaIds.includes(visit.areaId))continue;
      if(requirement.status!=='approved')fail('REQUIREMENT_PENDING',`Requisito de segurança sem aprovação: ${requirement.name}.`);
      if(!requirement.validUntil||Date.parse(requirement.validUntil)<=Date.parse(at))fail('REQUIREMENT_EXPIRED',`Requisito de segurança vencido: ${requirement.name}.`);
    }
  }
  if(visit.areaId) {
    const area=find(state.accessAreas,visit.areaId,'Setor de destino');if(!area.active)fail('INACTIVE_MASTER','O setor está inativo.');
    if(area.restricted&&(!person||!(person.allowedAreaIds??[]).includes(area.id)))fail('AREA_PERMISSION_REQUIRED','O destino exige permissão específica para a pessoa.');
  }
  if(visit.stayId) {
    const stay=find(state.stays,visit.stayId,'Atracação');
    if(stay.status!=='active'||(entry&&(Date.parse(at)<Date.parse(stay.start)||(stay.plannedEnd&&Date.parse(at)>Date.parse(stay.plannedEnd)))))fail('STAY_UNAVAILABLE','O acesso exige atracação ativa dentro do período operacional.');
    const manifest=(state.crewManifests??[]).find(m=>m.active&&m.stayId===stay.id&&m.personIds.includes(person?.id));
    if(!manifest)fail('MANIFEST_REQUIRED','Vincule a pessoa ao manifesto ativo desta atracação.');
  }
  return person;
}
export function assertNoDuplicatePresence(state,visit) {
  if((state.visitors??[]).some(other=>other.id!==visit.id&&other.status==='inside'&&((visit.personId&&other.personId===visit.personId)||((!visit.personId||!other.personId)&&normalizedIdentity(other.name)===normalizedIdentity(visit.name)&&normalizedIdentity(other.company)===normalizedIdentity(visit.company)))))fail('DUPLICATE','Esta pessoa já possui uma entrada em aberto.');
}
export function assertVisitEntry(state,visit,payload,at,actor) {
  if(visit.status!=='authorized')fail('INVALID_TRANSITION','A entrada exige autorização aprovada.');
  if(Date.parse(at)<Date.parse(visit.expectedAt)||Date.parse(at)>Date.parse(visit.validUntil))fail('OUTSIDE_VALIDITY','Entrada fora do período autorizado.');
  assertVisitEligibility(state,visit,at,{entry:true});
  assertNoDuplicatePresence(state,visit);
  if(payload.identityConfirmed!==true)fail('IDENTITY_REQUIRED','Confira o documento e confirme a identidade antes de registrar cada entrada.');
  return {identityConfirmedAt:instant(at,'Conferência de identidade'),identityConfirmedBy:text(actor.name,'Operador')};
}
export function normalizeVehiclePeople(state,payload,current={}) {
  const driverPersonId=text(payload.driverPersonId??current.driverPersonId,'Pessoa motorista',150,false)||null,occupantPersonIds=ids(payload.occupantPersonIds??current.occupantPersonIds??[],'Acompanhantes',100);
  if(driverPersonId&&occupantPersonIds.includes(driverPersonId))fail('DUPLICATE','O motorista não pode ser repetido como acompanhante.');
  for(const id of [driverPersonId,...occupantPersonIds].filter(Boolean)){const person=find(state.people,id,'Pessoa');if(!person.active)fail('INACTIVE_MASTER','Uma pessoa vinculada está inativa.');}
  return {driverPersonId,occupantPersonIds,cargo:text(payload.cargo??current.cargo,'Carga ou operação',500,false)};
}
export function normalizeCrewManifest(state,payload,at,actor,current={}) {
  const stayId=text(payload.stayId??current.stayId,'Atracação'),stay=find(state.stays,stayId,'Atracação');if(stay.status!=='active')fail('STAY_UNAVAILABLE','O manifesto exige uma atracação ativa.');
  if(current.stayId&&stayId!==current.stayId)fail('VALIDATION','O manifesto deve preservar a atracação original.');
  const personIds=ids(payload.personIds??current.personIds??[],'Pessoas do manifesto');if(!personIds.length)fail('VALIDATION','Inclua pelo menos uma pessoa no manifesto.');
  const responsiblePersonId=text(payload.responsiblePersonId??current.responsiblePersonId,'Responsável a bordo');
  if(!personIds.includes(responsiblePersonId))fail('VALIDATION','O responsável a bordo deve integrar o manifesto.');
  for(const id of personIds){const person=find(state.people,id,'Pessoa do manifesto');if(!person.active)fail('INACTIVE_MASTER','Uma pessoa do manifesto está inativa.');}
  const active=boolean(payload.active??current.active??true,'Situação do manifesto');
  if(active&&(state.crewManifests??[]).some(m=>m.id!==current.id&&m.active&&m.stayId===stayId))fail('DUPLICATE','A atracação já possui um manifesto ativo.');
  return {stayId,vesselId:stay.vesselId??null,responsiblePersonId,personIds,active,notes:text(payload.notes??current.notes,'Observações',2000,false),createdAt:current.createdAt??at,createdBy:current.createdBy??actor.name,updatedAt:at,updatedBy:actor.name};
}
export function createEmergencyRollCall(state,payload,at,actor) {
  if((state.emergencyRollCalls??[]).some(r=>r.status==='open'))fail('INVALID_TRANSITION','Já existe uma conferência de emergência aberta.');
  return {title:text(payload.title??'Conferência de emergência','Título'),status:'open',startedAt:at,startedBy:actor.name,people:(state.visitors??[]).filter(v=>v.status==='inside').map(v=>({visitorId:v.id,personId:v.personId??null,name:v.name,company:v.company,areaId:v.areaId??null,areaName:state.accessAreas?.find(a=>a.id===v.areaId)?.name??'Não informado',gateName:v.gateName,host:v.host,confirmedAt:null,confirmedBy:null,note:''})),closedAt:null,closedBy:null};
}
export function reconcileEmergencyRollCall(record,payload,at,actor) {
  if(record.status!=='open')fail('INVALID_TRANSITION','A conferência de emergência já foi encerrada.');
  const row=record.people.find(p=>p.visitorId===text(payload.visitorId,'Pessoa da conferência'));if(!row)fail('NOT_FOUND','Pessoa ausente da lista de emergência.');
  const confirmed=boolean(payload.confirmed,'Confirmação física'),next=structuredClone(record),target=next.people.find(p=>p.visitorId===row.visitorId);
  Object.assign(target,{confirmedAt:confirmed?at:null,confirmedBy:confirmed?actor.name:null,note:text(payload.note,'Observação da conferência',2000,false),reconciledAt:at,reconciledBy:actor.name});return next;
}
export function normalizeOpeningHours(settings) {
  const openingTime=text(settings.openingTime,'Horário de abertura',5,false),closingTime=text(settings.closingTime,'Horário de encerramento',5,false);
  if([openingTime,closingTime].some(v=>v&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(v))||Boolean(openingTime)!==Boolean(closingTime))fail('VALIDATION','Informe abertura e encerramento no formato HH:mm, ou deixe ambos vazios para operação 24 horas.');
  return {openingTime,closingTime};
}
export function isAfterHours(settings,at) {
  const {openingTime,closingTime}=normalizeOpeningHours(settings);if(!openingTime||openingTime===closingTime)return false;
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:settings.timezone??'America/Manaus',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)),time=`${parts.find(p=>p.type==='hour').value}:${parts.find(p=>p.type==='minute').value}`;
  return openingTime<closingTime?(time<openingTime||time>=closingTime):(time<openingTime&&time>=closingTime);
}
export function accessOverview(state,at=new Date().toISOString()) {
  const now=Date.parse(instant(at,'Data do painel')),people=new Map((state.people??[]).map(p=>[p.id,p]));
  const visits=(state.visitors??[]).map(v=>({...v,category:people.get(v.personId)?.category??v.category??'visitor',areaName:state.accessAreas?.find(a=>a.id===v.areaId)?.name??'Não informado',elapsedMinutes:v.enteredAt?Math.max(0,Math.floor((now-Date.parse(v.enteredAt))/60000)):0}));
  const inside=visits.filter(v=>v.status==='inside'),pending=visits.filter(v=>v.status==='pending'&&Date.parse(v.validUntil)>=now),expected=visits.filter(v=>v.status==='authorized'&&Date.parse(v.validUntil)>=now),expired=visits.filter(v=>['pending','authorized'].includes(v.status)&&Date.parse(v.validUntil)<now),overstayed=inside.filter(v=>now>Math.min(Date.parse(v.validUntil),Date.parse(v.enteredAt)+(state.settings.visitorOverstayHours??8)*3600000)),afterHours=isAfterHours(state.settings,at)?inside:[];
  const countBy=key=>Object.entries(inside.reduce((out,v)=>{const keyValue=key(v);out[keyValue]=(out[keyValue]??0)+1;return out;},{})).map(([name,count])=>({name,count}));
  const approved=visits.filter(v=>v.approvedAt),averageApprovalMinutes=approved.length?Math.round(approved.reduce((sum,v)=>sum+Math.max(0,Date.parse(v.approvedAt)-Date.parse(v.requestedAt)),0)/approved.length/60000):0;
  const hours=Array.from({length:24},(_,hour)=>({hour:String(hour).padStart(2,'0'),entries:0,exits:0})),hourAt=value=>Number(new Intl.DateTimeFormat('en-GB',{timeZone:state.settings.timezone??'America/Manaus',hour:'2-digit',hourCycle:'h23'}).format(new Date(value)));
  for(const visit of visits){if(visit.enteredAt)hours[hourAt(visit.enteredAt)].entries++;if(visit.leftAt)hours[hourAt(visit.leftAt)].exits++;}
  return {inside,pending,expected,overstayed,expired,afterHours,requirementAlerts:personRequirementAlerts(state,at),byArea:countBy(v=>v.areaName),byGate:countBy(v=>v.gateName),byCategory:countBy(v=>v.category),flowByHour:hours,averageApprovalMinutes};
}

/** Valida referências históricas sem reaplicar regras atuais de elegibilidade. */
export function validatePhysicalAccessState(state) {
  for(const person of state.people){normalizePersonAccess(person,person,{historical:true});for(const areaId of person.allowedAreaIds??[])find(state.accessAreas,areaId,'Área permitida');}
  const areaNames=new Set();for(const area of state.accessAreas){normalizeAccessArea(area);const name=normalizedIdentity(area.name);if(areaNames.has(name))fail('INVALID_BACKUP','Setores repetidos.');areaNames.add(name);instant(area.createdAt,'Criação do setor');instant(area.updatedAt,'Atualização do setor');text(area.createdBy,'Autor do setor');text(area.updatedBy,'Autor do setor');if(Date.parse(area.updatedAt)<Date.parse(area.createdAt))fail('INVALID_BACKUP','Setor fora de ordem.');}
  const inside=[];for(const visit of state.visitors.filter(v=>v.status==='inside')){if(inside.some(other=>(!visit.personId||!other.personId)&&normalizedIdentity(visit.name)===normalizedIdentity(other.name)&&normalizedIdentity(visit.company)===normalizedIdentity(other.company)))fail('INVALID_BACKUP','Pessoa com entradas simultâneas.');inside.push(visit);}
  for(const visit of state.visitors){normalizeVisitResponsibility(visit);if(visit.areaId)find(state.accessAreas,visit.areaId,'Setor da visita');if(visit.stayId)find(state.stays,visit.stayId,'Atracação da visita');if(visit.reassignedAt!=null){instant(visit.reassignedAt,'Alteração do responsável');text(visit.reassignedBy,'Autor da alteração do responsável');if(Date.parse(visit.reassignedAt)<Date.parse(visit.requestedAt))fail('INVALID_BACKUP','Alteração de responsável anterior à visita.');}else if(visit.reassignedBy)fail('INVALID_BACKUP','Alteração de responsável sem data.');if(visit.identityConfirmedAt!=null){instant(visit.identityConfirmedAt,'Conferência de identidade');text(visit.identityConfirmedBy,'Operador da conferência');if(!visit.enteredAt||Date.parse(visit.identityConfirmedAt)!==Date.parse(visit.enteredAt))fail('INVALID_BACKUP','Conferência de identidade inconsistente.');}else if(visit.identityConfirmedBy)fail('INVALID_BACKUP','Conferência de identidade sem data.');if(visit.identityReconfirmedAt!=null){instant(visit.identityReconfirmedAt,'Nova conferência de identidade');text(visit.identityReconfirmedBy,'Operador da nova conferência');if(!visit.enteredAt||!visit.correctedAt||Date.parse(visit.identityReconfirmedAt)<Date.parse(visit.enteredAt)||Date.parse(visit.identityReconfirmedAt)>Date.parse(visit.correctedAt))fail('INVALID_BACKUP','Nova conferência de identidade inconsistente.');}else if(visit.identityReconfirmedBy)fail('INVALID_BACKUP','Nova conferência sem data.');}
  const requirementNames=new Set();for(const requirement of state.personRequirements??[]) {
    normalizePersonRequirement(state,requirement,requirement.reviewedAt,{name:requirement.reviewedBy,id:requirement.reviewedByUserId},{},{historical:true});
    const key=JSON.stringify([requirement.personId,normalizedIdentity(requirement.name)]);if(requirementNames.has(key))fail('INVALID_BACKUP','Requisitos repetidos para a pessoa.');requirementNames.add(key);
    for(const field of ['createdAt','updatedAt','reviewedAt'])instant(requirement[field],'Data do requisito');
    for(const field of ['createdBy','updatedBy','reviewedBy'])text(requirement[field],'Autor do requisito');
    const created=Date.parse(requirement.createdAt),updated=Date.parse(requirement.updatedAt),reviewed=Date.parse(requirement.reviewedAt);
    if(updated<created||reviewed<created||reviewed!==updated)fail('INVALID_BACKUP','Conferência do requisito fora de ordem.');
  }
  for(const vehicle of state.vehicles){const occupants=ids(vehicle.occupantPersonIds??[],'Acompanhantes',100);if(vehicle.driverPersonId&&occupants.includes(vehicle.driverPersonId))fail('INVALID_BACKUP','Motorista repetido como acompanhante.');for(const personId of [vehicle.driverPersonId,...occupants].filter(Boolean))find(state.people,personId,'Ocupante');text(vehicle.cargo,'Carga',500,false);}
  for(const correction of state.accessCorrections){if(correction.type!=='exit_without_entry')fail('INVALID_BACKUP','Tipo de correção de acesso inválido.');find(state.people,correction.personId,'Pessoa da correção');text(correction.name,'Pessoa da correção');text(correction.company,'Empresa da correção',150,false);text(correction.gateName,'Portaria',100);text(correction.reason,'Justificativa',1000);instant(correction.occurredAt,'Saída física');instant(correction.createdAt,'Registro da correção');text(correction.createdBy,'Autor da correção');if(Date.parse(correction.occurredAt)>Date.parse(correction.createdAt))fail('INVALID_BACKUP','A saída física não pode estar após o registro da correção.');}
  const activeStays=new Set();for(const manifest of state.crewManifests){const stay=find(state.stays,manifest.stayId,'Atracação do manifesto');const members=ids(manifest.personIds,'Pessoas do manifesto');if(!members.length||!members.includes(manifest.responsiblePersonId))fail('INVALID_BACKUP','Responsável do manifesto inconsistente.');for(const personId of members)find(state.people,personId,'Pessoa do manifesto');boolean(manifest.active,'Situação do manifesto');if((manifest.vesselId??null)!==(stay.vesselId??null))fail('INVALID_BACKUP','Embarcação do manifesto inconsistente.');if(manifest.active){if(activeStays.has(stay.id))fail('INVALID_BACKUP','Manifestos ativos repetidos.');activeStays.add(stay.id);}instant(manifest.createdAt,'Criação do manifesto');instant(manifest.updatedAt,'Atualização do manifesto');text(manifest.createdBy,'Autor do manifesto');text(manifest.updatedBy,'Autor do manifesto');if(Date.parse(manifest.updatedAt)<Date.parse(manifest.createdAt))fail('INVALID_BACKUP','Manifesto fora de ordem.');}
  let open=0;
  for(const roll of state.emergencyRollCalls) {
    text(roll.title,'Conferência');instant(roll.startedAt,'Início da conferência');text(roll.startedBy,'Autor da conferência');
    if(!['open','closed'].includes(roll.status)||!Array.isArray(roll.people)||roll.people.length>50000)fail('INVALID_BACKUP','Conferência inválida.');
    if(roll.status==='open')open++;
    const seen=new Set();
    for(const row of roll.people) {
      const visit=find(state.visitors,row.visitorId,'Visita da conferência');
      if(seen.has(visit.id)||!visit.enteredAt||Date.parse(visit.enteredAt)>Date.parse(roll.startedAt)||(visit.leftAt&&Date.parse(visit.leftAt)<Date.parse(roll.startedAt)))fail('INVALID_BACKUP','Lista de conferência inconsistente.');
      seen.add(visit.id);text(row.name,'Pessoa da conferência');text(row.host,'Responsável');text(row.company,'Empresa',150,false);text(row.areaName,'Setor');text(row.gateName,'Portaria',100);
      if(row.personId)find(state.people,row.personId,'Pessoa da conferência');
      if(row.areaId)find(state.accessAreas,row.areaId,'Área da conferência');
      text(row.note,'Observação',2000,false);
      if(row.confirmedAt) {
        instant(row.confirmedAt,'Conferência física');text(row.confirmedBy,'Autor da conferência física');
        if(Date.parse(row.confirmedAt)<Date.parse(roll.startedAt))fail('INVALID_BACKUP','Conferência anterior ao início.');
      } else if(row.confirmedBy)fail('INVALID_BACKUP','Conferência física sem data.');
      if(row.reconciledAt) {
        instant(row.reconciledAt,'Reconciliação');text(row.reconciledBy,'Autor da reconciliação');
        if(Date.parse(row.reconciledAt)<Date.parse(roll.startedAt))fail('INVALID_BACKUP','Reconciliação anterior ao início.');
      }
    }
    if(roll.status==='closed') {
      instant(roll.closedAt,'Encerramento da conferência');text(roll.closedBy,'Autor do encerramento');
      if(Date.parse(roll.closedAt)<Date.parse(roll.startedAt)||roll.people.some(p=>[p.reconciledAt,p.confirmedAt].some(value=>value&&Date.parse(value)>Date.parse(roll.closedAt))))fail('INVALID_BACKUP','Encerramento da conferência inconsistente.');
      const unresolved=roll.people.filter(p=>!p.confirmedAt).length;
      if(roll.unresolvedCount!==unresolved)fail('INVALID_BACKUP','Contagem de pessoas não localizadas inconsistente.');
      text(roll.reason,'Justificativa do encerramento',1000,unresolved>0);
    } else if(roll.closedAt||roll.closedBy)fail('INVALID_BACKUP','Conferência aberta com encerramento.');
  }
  if(open>1)fail('INVALID_BACKUP','Conferências simultâneas.');
  return state;
}
