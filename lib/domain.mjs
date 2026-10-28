import { ACCESS_COLLECTIONS, normalizePersonAccess, normalizeAccessArea, normalizeVisitAccess, normalizeVisitResponsibility, assertVisitDecisionAuthority, normalizePersonRequirement, assertVisitEligibility, assertVisitEntry, assertNoDuplicatePresence, normalizeVehiclePeople, normalizeCrewManifest, createEmergencyRollCall, reconcileEmergencyRollCall, normalizeOpeningHours, personIdentityKey, normalizedIdentity, validatePhysicalAccessState } from './physical-access.mjs';
import { assertActiveCommand, assertActiveDestination, RETIRED_COMMANDS } from './module-policy.mjs';
/** Regras operacionais compartilhadas. A API é responsável pela identidade e pelo relógio. */
const PERMISSIONS = {
  director: ['VISITOR_REQUEST','VISITOR_APPROVE','VISITOR_REJECT','VISITOR_REVOKE','VISITOR_CANCEL','RECORD_CORRECT','MASTER_SAVE','RESERVATION_SAVE','RESERVATION_CANCEL','INCIDENT_CREATE','INCIDENT_UPDATE','SHIFT_HANDOVER','SHIFT_ACKNOWLEDGE','ACCESS_AREA_SAVE','PERSON_REQUIREMENT_SAVE','CREW_MANIFEST_SAVE','EMERGENCY_START','EMERGENCY_RECONCILE','EMERGENCY_CLOSE','ACCESS_EXIT_CORRECT'],
  gate: ['VISITOR_REQUEST','VISITOR_CHECKIN','VISITOR_CHECKOUT','VISITOR_CANCEL','VEHICLE_ENTER','VEHICLE_EXIT','MASTER_SAVE','INCIDENT_CREATE','INCIDENT_UPDATE','SHIFT_HANDOVER','SHIFT_ACKNOWLEDGE','EMERGENCY_START','EMERGENCY_RECONCILE','EMERGENCY_CLOSE'],
  operations: ['STAY_OPEN','STAY_CLOSE','RECORD_CORRECT','MASTER_SAVE','RESERVATION_SAVE','RESERVATION_CANCEL','INCIDENT_CREATE','INCIDENT_UPDATE','SHIFT_HANDOVER','SHIFT_ACKNOWLEDGE','ACCESS_AREA_SAVE','PERSON_REQUIREMENT_SAVE','CREW_MANIFEST_SAVE','EMERGENCY_START','EMERGENCY_RECONCILE','EMERGENCY_CLOSE','ACCESS_EXIT_CORRECT'],
  finance: ['SETTINGS_UPDATE','CHARGE_PAID','CHARGE_PAYMENT','CHARGE_CANCEL','PAYMENT_REVERSE','MASTER_SAVE','CONTRACT_SAVE','MONTH_CLOSE'],
  reader: [],
};
const COMMANDS = new Set([...Object.values(PERMISSIONS).flat(), 'BERTH_ADD', 'BERTH_REMOVE']);
export const COLLECTIONS = ['visitors','vehicles','stays','charges','people','fleet','vessels','companies','tariffHistory','contracts','reservations','incidents','handovers','settlements',...ACCESS_COLLECTIONS];
const NEW_COLLECTIONS=['contracts','reservations','incidents','handovers','settlements',...ACCESS_COLLECTIONS];
export const ROLES = ['admin','director','gate','operations','finance','reader'];
export function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
export function canonicalRole(role) { return role === 'ops' ? 'operations' : role; }
export function can(role, type) {
  if(canonicalRole(role)==='finance'&&type!=='READ')return false;
  return !RETIRED_COMMANDS.includes(type)&&historicalCan(role,type);
}
function historicalCan(role, type) {
  role = canonicalRole(role);
  if (!ROLES.includes(role)) return false;
  return type === 'READ' || ((role === 'admin' || PERMISSIONS[role]?.includes(type)) && COMMANDS.has(type));
}
function text(value,label,max=250) {
  if (typeof value !== 'string' || !value.trim()) fail('VALIDATION',`${label} é obrigatório.`);
  const answer=value.trim(); if (answer.length>max) fail('VALIDATION',`${label} deve ter até ${max} caracteres.`); return answer;
}
function optional(value,label,max=250) { return value == null || value === '' ? '' : text(value,label,max); }
function integer(value,label,min=0,max=Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value)||value<min||value>max) fail('VALIDATION',`${label} deve ser um número inteiro entre ${min} e ${max}.`); return value;
}
function instant(value,label) {
  const parts=typeof value==='string'?value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i):null;
  if(!parts) fail('VALIDATION',`${label} deve conter data, hora e fuso válidos.`);
  const [,year,month,day,hour,minute,second,,zone]=parts;
  const days=new Date(Date.UTC(Number(year),Number(month),0)).getUTCDate();
  if(Number(month)<1||Number(month)>12||Number(day)<1||Number(day)>days||Number(hour)>23||Number(minute)>59||Number(second??0)>59||(zone!=='Z'&&zone!=='z'&&(Number(zone.slice(1,3))>23||Number(zone.slice(4,6))>59))||!Number.isFinite(Date.parse(value))) fail('VALIDATION',`${label} deve conter data, hora e fuso válidos.`);
  return new Date(value).toISOString();
}
function normalize(value) { return value.normalize('NFD').replace(/[\u0300-\u036f\s-]/g,'').toUpperCase(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function find(items,key,label) { const record=items.find(x=>x.id===text(key,'Identificador',150)); if (!record) fail('NOT_FOUND',`${label} não encontrado.`); return record; }
function activeMaster(items,key,label) {const record=find(items,key,label);if(record.active!==true) fail('INACTIVE_MASTER',`${label} está inativo. Reative o cadastro antes de utilizar.`);return record;}
function status(record,expected,message) { if (![].concat(expected).includes(record.status)) fail('INVALID_TRANSITION',message); }
function reason(payload) { return text(payload.reason,'Justificativa',1000); }
function list(value,label) {
  if (!Array.isArray(value)||value.length>100) fail('VALIDATION',`${label} deve ser uma lista com até 100 itens.`);
  const answer=value.map(v=>text(v,label,100)); if(new Set(answer.map(normalize)).size!==answer.length) fail('DUPLICATE',`${label} não pode conter nomes repetidos.`); return answer;
}
function tariffSnapshot(value) {
  if(!value||typeof value!=='object') fail('VALIDATION','Tarifa inválida.');
  if((value.unitHours??24)!==24) fail('VALIDATION','A cobrança utiliza diárias iniciadas de 24 horas.');
  return {name:text(value.name??'Tarifa padrão','Nome da tarifa',100),dailyRateCents:integer(value.dailyRateCents,'Diária em centavos',0,1000000000),toleranceMinutes:integer(value.toleranceMinutes??0,'Tolerância em minutos',0,43200),unitHours:24,version:integer(value.version??1,'Versão da tarifa',1)};
}
function contractTerms(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))fail('VALIDATION','Condições contratuais inválidas.');
  const validFrom=instant(value.validFrom,'Início da vigência'),validUntil=instant(value.validUntil,'Fim da vigência');
  if(Date.parse(validUntil)<=Date.parse(validFrom)) fail('INVALID_PERIOD','O fim da vigência deve ser posterior ao início.');
  if(typeof value.active!=='boolean') fail('VALIDATION','Informe se o contrato está ativo.');
  return {name:text(value.name,'Nome do contrato',100),client:text(value.client,'Cliente',150),dailyRateCents:integer(value.dailyRateCents,'Diária em centavos',0,1000000000),toleranceMinutes:integer(value.toleranceMinutes,'Tolerância em minutos',0,43200),dueDays:integer(value.dueDays,'Prazo de vencimento em dias',0,365),validFrom,validUntil,active:value.active};
}
function idList(value,label,max=100) {
  if(!Array.isArray(value)||value.length>max) fail('VALIDATION',`${label} deve ser uma lista com até ${max} itens.`);
  const answer=value.map(v=>text(v,label,150));if(new Set(answer).size!==answer.length)fail('DUPLICATE',`${label} contém referências repetidas.`);return answer;
}
function overlaps(start,end,otherStart,otherEnd) {return Date.parse(start)<(otherEnd?Date.parse(otherEnd):Infinity)&&Date.parse(otherStart)<(end?Date.parse(end):Infinity);}
function sameVessel(a,b) {return normalize(text(a.registration,'Registro',100))===normalize(text(b.registration,'Registro',100))||normalize(text(a.vesselName,'Embarcação',150))===normalize(text(b.vesselName,'Embarcação',150));}
function assertReservationConflicts(state,record,ignoreReservationId=null,ignoreStayId=null) {
  const conflicting=state.reservations.some(r=>r.id!==ignoreReservationId&&r.status==='confirmed'&&(r.berth===record.berth||sameVessel(r,record))&&overlaps(record.start,record.end,r.start,r.end));
  if(conflicting)fail('RESERVATION_CONFLICT','O berço ou a embarcação já possui reserva neste intervalo.');
  if(state.stays.some(s=>s.id!==ignoreStayId&&s.status==='active'&&(s.berth===record.berth||sameVessel(s,record))&&overlaps(record.start,record.end,s.start,s.plannedEnd)))fail('RESERVATION_CONFLICT','O intervalo conflita com uma atracação em andamento. Informe ou ajuste a previsão de saída.');
}
export function monthInTimezone(value,timezone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit'}).formatToParts(new Date(instant(value,'Data do mês')));
  return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}`;
}
function monthValue(value) {const answer=text(value,'Mês',7);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(answer))fail('VALIDATION','Informe o mês no formato AAAA-MM.');return answer;}
export function monthlyPreview(state,client,month,timezone=state.settings.timezone) {
  client=text(client,'Cliente',150);month=monthValue(month);
  const charges=state.charges.filter(c=>normalize(c.client)===normalize(client)&&monthInTimezone(c.createdAt,timezone)===month);
  const items=charges.map(c=>({chargeId:c.id,totalCents:c.totalCents,paidCents:c.paidCents,balanceCents:c.balanceCents,status:c.status}));
  const included=items.filter(c=>c.status!=='cancelled');
  return {client,month,timezone,chargeIds:items.map(c=>c.chargeId),items,totalCents:included.reduce((s,c)=>s+c.totalCents,0),paidCents:included.reduce((s,c)=>s+c.paidCents,0),balanceCents:included.reduce((s,c)=>s+c.balanceCents,0),cancelledCents:items.filter(c=>c.status==='cancelled').reduce((s,c)=>s+c.totalCents,0)};
}
/** Tolerância única, seguida por blocos completos de 24h ou fração; zero tempo custa zero. */
export function calculateCharge(startISO,endISO,tariff) {
  const start=instant(startISO,'Início'),end=instant(endISO,'Fim'),snapshot=tariffSnapshot(tariff);
  const elapsed=Date.parse(end)-Date.parse(start); if(elapsed<0) fail('INVALID_PERIOD','O fim não pode ser anterior ao início.');
  const elapsedSeconds=Math.ceil(elapsed/1000),billableSeconds=Math.max(0,elapsedSeconds-snapshot.toleranceMinutes*60),units=Math.ceil(billableSeconds/86400),totalCents=units*snapshot.dailyRateCents;
  if(!Number.isSafeInteger(totalCents)) fail('VALIDATION','Valor calculado excede o limite permitido.');
  return {elapsedSeconds,billableSeconds,units,totalCents};
}
export function createInitialState() {
  return {version:2,...Object.fromEntries(COLLECTIONS.map(k=>[k,[]])),audit:[],berths:[],settings:{unitName:'Minha unidade portuária',timezone:'America/Manaus',dailyRateCents:0,toleranceMinutes:0,unitHours:24,name:'Tarifa padrão',configured:false,version:1,gateNames:['Portaria principal'],overdueHours:48,visitorOverstayHours:8,dueDays:7}};
}
function validateSettings(value) {
  const tariff=tariffSnapshot(value);
  const timezone=text(value.timezone,'Fuso horário',100); try { new Intl.DateTimeFormat('pt-BR',{timeZone:timezone}).format(); } catch { fail('VALIDATION','Fuso horário IANA inválido.'); }
  if(typeof value.configured!=='boolean') fail('VALIDATION','Informe se a tarifa está configurada.');
  const gateNames=list(value.gateNames,'Portarias'); if(!gateNames.length) fail('VALIDATION','Cadastre pelo menos uma portaria.');
  return {...tariff,unitName:text(value.unitName,'Nome da unidade',150),timezone,configured:value.configured,gateNames,...normalizeOpeningHours(value),overdueHours:integer(value.overdueHours,'Alerta de atracação em horas',1,8760),visitorOverstayHours:integer(value.visitorOverstayHours,'Alerta de visita em horas',1,8760),dueDays:integer(value.dueDays,'Prazo de vencimento em dias',0,365)};
}
function gateName(payload,state) { const gate=optional(payload.gateName,'Portaria',100)||state.settings.gateNames[0]; if(!state.settings.gateNames.includes(gate)) fail('VALIDATION','Selecione uma portaria cadastrada.'); return gate; }
function paymentTotals(charge) {
  charge.payments??=[];
  charge.paidCents=charge.payments.filter(p=>!p.reversedAt).reduce((sum,p)=>sum+p.amountCents,0);
  charge.balanceCents=charge.totalCents-charge.paidCents;
  if(charge.status!=='cancelled') charge.status=charge.balanceCents===0?'paid':charge.paidCents>0?'partial':'pending';
  charge.paidAt=charge.status==='paid'?(charge.payments.filter(p=>!p.reversedAt).at(-1)?.receivedAt??charge.createdAt):null;
}
function allowedMaster(role,kind) { return role==='admin'||({director:['people','companies'],gate:['people','fleet'],operations:['people','vessels','companies'],finance:['companies']}[role]??[]).includes(kind); }
function accessManager(role) {return ['admin','director','operations'].includes(role);}
function revokePersonVisits(state,person,at,actorName) {
  if(person.active&&person.securityStatus!=='blocked')return;
  for(const visit of state.visitors)if(visit.personId===person.id&&['pending','authorized'].includes(visit.status))Object.assign(visit,{status:'revoked',revokedAt:at,revokedBy:actorName,reason:person.active?'Credencial revogada: pessoa bloqueada pela segurança.':'Credencial revogada: cadastro da pessoa desativado.'});
}
function auditDiff(before,next) {
  const changes=[];
  for(const kind of COLLECTIONS) {
    const previous=new Map((before[kind]??[]).map(x=>[x.id,x]));
    for(const record of next[kind]??[]) { const old=previous.get(record.id); if(JSON.stringify(old)!==JSON.stringify(record)) changes.push({kind,id:record.id,before:old??null,after:structuredClone(record)}); previous.delete(record.id); }
    for(const old of previous.values()) changes.push({kind,id:old.id,before:old,after:null});
  }
  for(const kind of ['settings','berths']) if(JSON.stringify(before[kind])!==JSON.stringify(next[kind])) changes.push({kind,id:kind,before:structuredClone(before[kind]),after:structuredClone(next[kind])});
  return changes;
}
/** Operação pura: o estado recebido nunca é alterado. O servidor fixa command.at e actor. */
export function execute(state,command,actor) {
  assertActiveCommand(command);
  if(command&&COMMANDS.has(command.type)&&!can(actor?.role,command.type))fail('FORBIDDEN','Seu perfil não permite esta operação.');
  return executeHistorical(state,command,actor);
}
// Private compatibility executor for the historical backup fixture only.
function executeHistorical(state,command,actor) {
  if(!state||state.version!==2) fail('INVALID_STATE','Versão de dados incompatível.');
  if(!command||!COMMANDS.has(command.type)) fail('UNKNOWN_COMMAND','Operação não reconhecida.');
  const role=canonicalRole(actor?.role); if(!historicalCan(role,command.type)) fail('FORBIDDEN','Seu perfil não permite esta operação.');
  const actorName=text(actor.name,'Nome do operador',150),at=instant(command.at??new Date().toISOString(),'Horário da operação'),payload=command.payload??{};
  if(!payload||typeof payload!=='object'||Array.isArray(payload)) fail('VALIDATION','Dados da operação inválidos.');
  const next=structuredClone(state);for(const kind of NEW_COLLECTIONS)next[kind]??=[]; let result,entity='settings',justification='';
  switch(command.type) {
    case 'VISITOR_REQUEST': {
      const expectedAt=instant(payload.expectedAt,'Previsão de entrada'),validUntil=instant(payload.validUntil,'Validade');
      if(Date.parse(validUntil)<Date.parse(expectedAt)) fail('INVALID_PERIOD','A validade não pode ser anterior à previsão.');
      const documentLast4=optional(payload.documentLast4,'Final do documento',4); if(documentLast4&&!/^\d{4}$/.test(documentLast4)) fail('VALIDATION','Informe somente os quatro últimos dígitos do documento.');
      let person;
      if(payload.personId)person=activeMaster(next.people,payload.personId,'Pessoa');
      else {
        const name=text(payload.name,'Visitante',150),company=text(payload.company,'Empresa',150),matching=next.people.filter(p=>normalizedIdentity(p.name)===normalizedIdentity(name)&&normalizedIdentity(p.company)===normalizedIdentity(company));
        const matches=documentLast4?matching.filter(p=>p.documentLast4===documentLast4):matching;
        if(matches.length>1)fail('VALIDATION','Há pessoas homônimas. Selecione o cadastro correto antes de solicitar a visita.');
        person=matches[0];
        if(person&&person.active!==true)fail('INACTIVE_MASTER','Pessoa inativa. Revise o cadastro antes de solicitar a visita.');
        if(!person) {
          const access=normalizePersonAccess({category:payload.category??'visitor',documentLast4});
          if(!accessManager(role)&&access.category==='employee')fail('FORBIDDEN','Somente um responsável pode cadastrar funcionários.');
          person={id:id('people'),name,company,active:true,...access,updatedAt:at,updatedBy:actorName};next.people.unshift(person);
        }
      }
      assertActiveDestination(person);
      const access=normalizeVisitAccess(next,payload),destination=next.accessAreas.find(a=>a.id===access.areaId);
      if(!accessManager(role)&&destination?.responsibleUserId&&(access.responsibleUserId!==destination.responsibleUserId||access.substituteUserId!==(destination.substituteUserId??null)))fail('FORBIDDEN','Seu perfil deve utilizar os responsáveis definidos para o setor.');
      result={id:id('vis'),name:person.name,company:text(person.company||payload.company,'Empresa',150),category:person.category??'visitor',purpose:text(payload.purpose,'Motivo da visita',500),host:text(payload.host,'Responsável',150),expectedAt,validUntil,documentLast4:person.documentLast4||documentLast4,gateName:gateName(payload,next),personId:person.id,...access,notes:optional(payload.notes,'Observação',2000),status:'pending',requestedAt:at,requestedBy:actorName,approvedAt:null,approvedBy:null,rejectedAt:null,rejectedBy:null,enteredAt:null,leftAt:null};
      next.visitors.unshift(result); entity='visitor'; break;
    }
    case 'VISITOR_APPROVE': {
      result=find(next.visitors,payload.id,'Visita'); status(result,'pending','Somente visitas pendentes podem ser autorizadas.');
      assertVisitDecisionAuthority(result,actor);
      if(Date.parse(at)>Date.parse(result.validUntil)) fail('EXPIRED','A solicitação está vencida.');
      assertVisitEligibility(next,result,at);
      Object.assign(result,{status:'authorized',approvedAt:at,approvedBy:actorName}); entity='visitor'; break;
    }
    case 'VISITOR_REJECT': {
      result=find(next.visitors,payload.id,'Visita');status(result,'pending','Somente visitas pendentes podem ser recusadas.');justification=reason(payload);
      assertVisitDecisionAuthority(result,actor);
      Object.assign(result,{status:'denied',rejectedAt:at,rejectedBy:actorName,reason:justification});entity='visitor';break;
    }
    case 'VISITOR_REVOKE': {
      result=find(next.visitors,payload.id,'Visita');status(result,'authorized','Somente uma autorização sem entrada pode ser revogada.');justification=reason(payload);
      assertVisitDecisionAuthority(result,actor);
      Object.assign(result,{status:'revoked',revokedAt:at,revokedBy:actorName,reason:justification});entity='visitor';break;
    }
    case 'VISITOR_CANCEL': {
      result=find(next.visitors,payload.id,'Visita');status(result,role==='gate'?['pending']:['pending','authorized'],'Esta visita não pode ser cancelada neste estágio ou pelo seu perfil.');justification=reason(payload);
      Object.assign(result,{status:'cancelled',cancelledAt:at,cancelledBy:actorName,reason:justification});entity='visitor';break;
    }
    case 'VISITOR_CHECKIN': {
      result=find(next.visitors,payload.id,'Visita');status(result,'authorized','A entrada exige autorização aprovada.');
      const confirmation=assertVisitEntry(next,result,payload,at,actor);
      Object.assign(result,{status:'inside',enteredAt:at,checkedInBy:actorName,gateName:gateName(payload,next),...confirmation});entity='visitor';break;
    }
    case 'VISITOR_CHECKOUT': {
      result=find(next.visitors,payload.id,'Visita');status(result,'inside','A visita não possui entrada em aberto.');
      if(Date.parse(at)<Date.parse(result.enteredAt)) fail('INVALID_PERIOD','A saída não pode preceder a entrada.');
      Object.assign(result,{status:'completed',leftAt:at,checkedOutBy:actorName});entity='visitor';break;
    }
    case 'VEHICLE_ENTER': {
      const plate=text(payload.plate,'Placa',15).replace(/[\s-]/g,'').toUpperCase();if(!/^[A-Z0-9]{5,10}$/.test(plate)) fail('VALIDATION','Placa inválida.');
      if(next.vehicles.some(v=>v.status==='inside'&&normalize(v.plate)===plate)) fail('DUPLICATE','O veículo já está no local.');
      let visitorId=null;if(payload.visitorId) { const visit=find(next.visitors,payload.visitorId,'Visita');status(visit,['authorized','inside'],'Vincule uma visita autorizada ou em andamento.');visitorId=visit.id; }
      const fleetId=payload.fleetId?activeMaster(next.fleet,payload.fleetId,'Veículo cadastrado').id:null;
      result={id:id('veh'),plate,driver:text(payload.driver,'Motorista',150),company:text(payload.company,'Empresa',150),purpose:text(payload.purpose,'Motivo',500),host:optional(payload.host,'Responsável',150),gateName:gateName(payload,next),visitorId,fleetId,...normalizeVehiclePeople(next,payload),notes:optional(payload.notes,'Observação',2000),status:'inside',entryAt:at,exitAt:null,enteredBy:actorName};next.vehicles.unshift(result);entity='vehicle';break;
    }
    case 'VEHICLE_EXIT': {
      result=find(next.vehicles,payload.id,'Veículo');status(result,'inside','O veículo não possui entrada em aberto.');if(Date.parse(at)<Date.parse(result.entryAt)) fail('INVALID_PERIOD','A saída não pode preceder a entrada.');
      Object.assign(result,{status:'completed',exitAt:at,exitedBy:actorName});entity='vehicle';break;
    }
    case 'STAY_OPEN': {
      if(!next.settings.configured) fail('SETUP_REQUIRED','Configure e confirme a tarifa na administração antes de iniciar uma atracação.');
      const vesselName=text(payload.vesselName,'Embarcação',150),registration=text(payload.registration,'Registro',100),berth=text(payload.berth,'Berço',100),start=instant(payload.start??at,'Início da atracação');
      const vesselId=payload.vesselId?activeMaster(next.vessels,payload.vesselId,'Embarcação cadastrada').id:null;
      if(Date.parse(start)>Date.parse(at)) fail('INVALID_PERIOD','O início efetivo não pode estar no futuro.');
      if(!next.berths.includes(berth)) fail('VALIDATION','Selecione um berço cadastrado.');
      if(next.stays.some(s=>s.status==='active'&&s.berth===berth)) fail('BERTH_OCCUPIED','O berço está ocupado.');
      if(next.stays.some(s=>s.status==='active'&&((vesselId&&s.vesselId===vesselId)||normalize(s.registration)===normalize(registration)||normalize(s.vesselName)===normalize(vesselName)))) fail('DUPLICATE','Esta embarcação já está atracada.');
      let plannedEnd=payload.plannedEnd?instant(payload.plannedEnd,'Saída prevista'):null;if(plannedEnd&&Date.parse(plannedEnd)<Date.parse(start)) fail('INVALID_PERIOD','A previsão de saída não pode preceder o início.');
      const client=text(payload.client,'Responsável financeiro',150),contract=payload.contractId?find(next.contracts,payload.contractId,'Contrato'):null;
      if(contract&&(!contract.active||normalize(contract.client)!==normalize(client)||Date.parse(start)<Date.parse(contract.validFrom)||Date.parse(start)>=Date.parse(contract.validUntil)))fail('INVALID_CONTRACT','Selecione um contrato ativo, vigente na chegada e pertencente ao responsável financeiro.');
      const reservation=payload.reservationId?find(next.reservations,payload.reservationId,'Reserva'):null;
      if(reservation){status(reservation,'confirmed','A reserva não está disponível para chegada.');if(reservation.berth!==berth||normalize(reservation.registration)!==normalize(registration)||normalize(reservation.vesselName)!==normalize(vesselName)||normalize(reservation.client)!==normalize(client))fail('INVALID_RESERVATION','A chegada deve usar embarcação, registro, cliente e berço da reserva.');if(Date.parse(start)>=Date.parse(reservation.end))fail('INVALID_PERIOD','A reserva venceu. Atualize o planejamento antes de registrar a chegada.');plannedEnd??=reservation.end;}
      assertReservationConflicts({...next,stays:[]},{vesselName,registration,berth,start,end:plannedEnd},reservation?.id);
      result={id:id('stay'),vesselName,registration,client,berth,start,end:null,plannedEnd,status:'active',tariff:tariffSnapshot(contract?{...contract,unitHours:24}:next.settings),dueDays:contract?.dueDays??next.settings.dueDays,contractId:contract?.id??null,contractVersion:contract?.version??null,contractSnapshot:contract?{...contractTerms(contract),version:contract.version}:null,reservationId:reservation?.id??null,chargeId:null,openedAt:at,openedBy:actorName,vesselId,notes:optional(payload.notes,'Observação',2000)};
      if(reservation)Object.assign(reservation,{status:'arrived',stayId:result.id,arrivedAt:at,arrivedBy:actorName,updatedAt:at,updatedBy:actorName});
      next.stays.unshift(result);entity='stay';break;
    }
    case 'STAY_CLOSE': {
      const stay=find(next.stays,payload.id,'Atracação');if(stay.status==='completed') { const existing=find(next.charges,stay.chargeId,'Cobrança');return {state:next,result:existing}; }
      status(stay,'active','Atracação sem permanência em aberto.');const end=instant(payload.end??at,'Fim da atracação');if(Date.parse(end)>Date.parse(at)) fail('INVALID_PERIOD','O fim efetivo não pode estar no futuro.');
      const dueDays=stay.dueDays??next.settings.dueDays,amount=calculateCharge(stay.start,end,stay.tariff),dueAt=new Date(Date.parse(at)+dueDays*86400000).toISOString();
      result={id:id('charge'),stayId:stay.id,vesselName:stay.vesselName,client:stay.client,createdAt:at,...amount,status:amount.totalCents===0?'paid':'pending',tariff:tariffSnapshot(stay.tariff),start:stay.start,end,dueAt,dueDays,contractId:stay.contractId??null,contractVersion:stay.contractVersion??null,contractSnapshot:stay.contractSnapshot??null,payments:[],paidCents:0,balanceCents:amount.totalCents,paidAt:amount.totalCents===0?at:null,paidBy:null};
      Object.assign(stay,{status:'completed',end,chargeId:result.id,closedAt:at,closedBy:actorName});
      for(const manifest of next.crewManifests)if(manifest.stayId===stay.id&&manifest.active)Object.assign(manifest,{active:false,updatedAt:at,updatedBy:actorName});
      for(const visit of next.visitors)if(visit.stayId===stay.id&&['pending','authorized'].includes(visit.status))Object.assign(visit,{status:'revoked',revokedAt:at,revokedBy:actorName,reason:'Credencial revogada: período de atracação encerrado.'});
      next.charges.unshift(result);entity='charge';break;
    }
    case 'SETTINGS_UPDATE': {
      const allowed=['dailyRateCents','toleranceMinutes','name','unitHours','configured','dueDays'];
      if(role==='finance'&&Object.keys(payload).some(k=>!allowed.includes(k))) fail('FORBIDDEN','O financeiro pode alterar somente a tarifa e o prazo de cobrança.');
      const tariffChanged=['dailyRateCents','toleranceMinutes','name','unitHours'].some(k=>Object.hasOwn(payload,k)&&payload[k]!==next.settings[k]);
      const merged=validateSettings({...next.settings,...payload,version:next.settings.version+(tariffChanged?1:0)});
      if(tariffChanged) next.tariffHistory.unshift({id:id('tariff'),changedAt:at,changedBy:actorName,previous:tariffSnapshot(next.settings),tariff:tariffSnapshot(merged)});
      next.settings=merged;result=merged;break;
    }
    case 'BERTH_ADD': {const name=text(payload.name,'Nome do berço',100);if(next.berths.some(b=>normalize(b)===normalize(name))) fail('DUPLICATE','Este berço já está cadastrado.');if(next.berths.length>=100) fail('VALIDATION','Limite de 100 berços atingido.');next.berths.push(name);result={id:name,name};entity='berth';break;}
    case 'BERTH_REMOVE': {const name=text(payload.name,'Nome do berço',100);if(!next.berths.includes(name)) fail('NOT_FOUND','Berço não encontrado.');if(next.stays.some(s=>s.status==='active'&&s.berth===name)) fail('BERTH_OCCUPIED','Encerre a atracação antes de remover o berço.');if(next.reservations.some(r=>r.berth===name&&r.status==='confirmed'&&Date.parse(r.end)>Date.parse(at)))fail('RESERVATION_CONFLICT','Cancele ou remaneje as reservas futuras antes de remover o berço.');next.berths=next.berths.filter(b=>b!==name);result={id:name,name};entity='berth';break;}
    case 'CONTRACT_SAVE': {
      const old=payload.id?find(next.contracts,payload.id,'Contrato'):null,terms=contractTerms(payload);
      result={...(old??{}),...terms,id:old?.id??id('contract'),version:(old?.version??0)+1,createdAt:old?.createdAt??at,createdBy:old?.createdBy??actorName,updatedAt:at,updatedBy:actorName};
      if(old)Object.assign(old,result);else next.contracts.unshift(result);entity='contract';break;
    }
    case 'RESERVATION_SAVE': {
      const old=payload.id?find(next.reservations,payload.id,'Reserva'):null;if(old)status(old,'confirmed','Somente reservas confirmadas podem ser alteradas.');
      const start=instant(payload.start,'Chegada prevista'),end=instant(payload.end,'Saída prevista');if(Date.parse(end)<=Date.parse(start)||Date.parse(end)<=Date.parse(at))fail('INVALID_PERIOD','A saída prevista deve ser posterior à chegada e ao horário atual.');
      const berth=text(payload.berth,'Berço',100);if(!next.berths.includes(berth))fail('VALIDATION','Selecione um berço cadastrado.');
      result={...(old??{}),id:old?.id??id('reservation'),vesselName:text(payload.vesselName,'Embarcação',150),registration:text(payload.registration,'Registro',100),client:text(payload.client,'Cliente',150),berth,start,end,notes:optional(payload.notes,'Observação',2000),status:'confirmed',stayId:null,createdAt:old?.createdAt??at,createdBy:old?.createdBy??actorName,updatedAt:at,updatedBy:actorName};
      assertReservationConflicts(next,result,old?.id);if(old)Object.assign(old,result);else next.reservations.unshift(result);entity='reservation';break;
    }
    case 'RESERVATION_CANCEL': {
      result=find(next.reservations,payload.id,'Reserva');status(result,'confirmed','Somente reservas confirmadas podem ser canceladas.');justification=reason(payload);Object.assign(result,{status:'cancelled',cancelledAt:at,cancelledBy:actorName,reason:justification,updatedAt:at,updatedBy:actorName});entity='reservation';break;
    }
    case 'INCIDENT_CREATE': {
      const severity=text(payload.severity,'Gravidade',20);if(!['low','medium','high','critical'].includes(severity))fail('VALIDATION','Gravidade inválida.');
      result={id:id('incident'),title:text(payload.title,'Título',150),description:text(payload.description,'Descrição',4000),category:text(payload.category,'Categoria',100),severity,location:text(payload.location,'Local',150),responsible:text(payload.responsible,'Responsável',150),attachmentIds:idList(payload.attachmentIds??[],'Anexos',8),status:'open',resolution:'',history:[{at,actor:actorName,status:'open',note:'Ocorrência registrada.'}],createdAt:at,createdBy:actorName,updatedAt:at,updatedBy:actorName};next.incidents.unshift(result);entity='incident';break;
    }
    case 'INCIDENT_UPDATE': {
      result=find(next.incidents,payload.id,'Ocorrência');const newStatus=text(payload.status,'Situação',30);if(!['open','in_progress','resolved'].includes(newStatus))fail('VALIDATION','Situação de ocorrência inválida.');
      if(result.status===newStatus)fail('INVALID_TRANSITION','A ocorrência já está nesta situação.');
      const resolution=newStatus==='resolved'?text(payload.resolution,'Solução',2000):'';
      const note=result.status==='resolved'?reason(payload):optional(payload.note,'Acompanhamento',2000);if(result.status==='resolved')justification=note;
      Object.assign(result,{status:newStatus,resolution,updatedAt:at,updatedBy:actorName});if(newStatus==='resolved')Object.assign(result,{resolvedAt:at,resolvedBy:actorName});else{result.resolvedAt=null;result.resolvedBy=null;}
      result.history.push({at,actor:actorName,status:newStatus,note:resolution||note||'Situação atualizada.'});entity='incident';break;
    }
    case 'SHIFT_HANDOVER': {
      const incidentIds=idList(payload.incidentIds??[],'Ocorrências vinculadas');for(const incidentId of incidentIds)find(next.incidents,incidentId,'Ocorrência');
      result={id:id('handover'),shift:text(payload.shift,'Turno',100),summary:text(payload.summary,'Resumo do turno',4000),pending:optional(payload.pending,'Pendências',4000),incidentIds,createdAt:at,createdBy:actorName,acknowledgements:[]};next.handovers.unshift(result);entity='handover';break;
    }
    case 'SHIFT_ACKNOWLEDGE': {
      result=find(next.handovers,payload.id,'Passagem de turno');const actorId=actor.id??null;if(result.acknowledgements.some(a=>actorId?a.actorId===actorId:a.actor===actorName))fail('DUPLICATE','Você já registrou ciência desta passagem de turno.');
      result.acknowledgements.push({at,actor:actorName,actorId,note:optional(payload.note,'Observação',2000)});entity='handover';break;
    }
    case 'MONTH_CLOSE': {
      const month=monthValue(payload.month),client=text(payload.client,'Cliente',150);if(month>=monthInTimezone(at,next.settings.timezone))fail('INVALID_PERIOD','O fechamento definitivo exige um mês já encerrado no fuso da unidade.');
      if(next.settlements.some(s=>s.month===month&&normalize(s.client)===normalize(client)))fail('DUPLICATE','Este cliente já possui fechamento para o mês.');
      const preview=monthlyPreview(next,client,month);if(!preview.items.length)fail('VALIDATION','Não há cobranças deste cliente no mês informado.');
      for(const field of ['totalCents','paidCents','balanceCents','cancelledCents'])integer(preview[field],'Total do fechamento',0);
      justification=optional(payload.reason,'Observação do fechamento',1000);result={id:id('settlement'),...preview,createdAt:at,createdBy:actorName,reason:justification};next.settlements.unshift(result);entity='settlement';break;
    }
    case 'CHARGE_PAID':
    case 'CHARGE_PAYMENT': {
      result=find(next.charges,payload.id??payload.chargeId,'Cobrança');status(result,['pending','partial'],'Esta cobrança não aceita recebimentos.');paymentTotals(result);
      const amountCents=command.type==='CHARGE_PAID'?result.balanceCents:integer(payload.amountCents,'Valor recebido',1);
      if(amountCents>result.balanceCents) fail('VALIDATION','O recebimento supera o saldo da cobrança.');
      const receivedAt=instant(payload.receivedAt??at,'Recebimento');if(Date.parse(receivedAt)>Date.parse(at)||Date.parse(receivedAt)<Date.parse(result.createdAt)) fail('INVALID_PERIOD','O recebimento deve estar entre a geração e o horário atual.');
      result.payments.push({id:id('payment'),amountCents,method:text(payload.method??'outro','Forma de pagamento',50),reference:optional(payload.reference,'Referência',200),receivedAt,registeredAt:at,registeredBy:actorName,reversedAt:null});paymentTotals(result);result.paidBy=result.status==='paid'?actorName:null;entity='charge';break;
    }
    case 'PAYMENT_REVERSE': {
      result=find(next.charges,payload.chargeId,'Cobrança');if(result.status==='cancelled') fail('INVALID_TRANSITION','Cobrança cancelada.');const payment=find(result.payments??[],payload.paymentId,'Recebimento');if(payment.reversedAt) fail('INVALID_TRANSITION','Recebimento já estornado.');justification=reason(payload);Object.assign(payment,{reversedAt:at,reversedBy:actorName,reversalReason:justification});paymentTotals(result);entity='charge';break;
    }
    case 'CHARGE_CANCEL': {
      result=find(next.charges,payload.id,'Cobrança');status(result,['pending','partial','paid'],'Esta cobrança já está cancelada.');paymentTotals(result);if(result.paidCents>0) fail('INVALID_TRANSITION','Estorne os recebimentos antes de cancelar a cobrança.');justification=reason(payload);Object.assign(result,{status:'cancelled',cancelledAt:at,cancelledBy:actorName,cancelReason:justification});entity='charge';break;
    }
    case 'MASTER_SAVE': {
      const kind=payload.kind;if(!['people','fleet','vessels','companies'].includes(kind)||!allowedMaster(role,kind)) fail('FORBIDDEN','Seu perfil não pode manter este cadastro.');
      const input=payload.record;if(!input||typeof input!=='object'||Array.isArray(input)) fail('VALIDATION','Cadastro inválido.');
      const old=input.id?find(next[kind],input.id,'Cadastro'):null;
      const record={...(old??{}),id:old?.id??id(kind),active:input.active??old?.active??true,updatedAt:at,updatedBy:actorName};if(typeof record.active!=='boolean') fail('VALIDATION','Situação do cadastro inválida.');
      if(kind==='fleet') {record.plate=text(input.plate??old?.plate,'Placa',15).replace(/[\s-]/g,'').toUpperCase();if(!/^[A-Z0-9]{5,10}$/.test(record.plate)) fail('VALIDATION','Placa inválida.');record.name=optional(input.name??old?.name,'Descrição',150);}
      else record.name=text(input.name??old?.name,'Nome',150);
      if(kind==='vessels') record.registration=text(input.registration??old?.registration,'Registro',100);
      for(const field of ['company','contact','phone','email','host','notes','driver','type']) if(Object.hasOwn(input,field)) record[field]=optional(input[field],field,field==='notes'?2000:200);
      if(kind==='people') {
        const access=normalizePersonAccess(input,old??{});
        if(!accessManager(role)) {
          if((old?.active===false&&record.active)||access.category==='employee'&&old?.category!=='employee'||access.securityStatus==='cleared'&&((old&&old.securityStatus&&old.securityStatus!=='cleared')||(access.category==='contractor'&&old?.category!=='contractor'))||access.allowedAreaIds.some(areaId=>!(old?.allowedAreaIds??[]).includes(areaId)))fail('FORBIDDEN','Seu perfil não pode conceder liberação de segurança, reativar pessoas ou ampliar permissões de acesso.');
        }
        for(const areaId of access.allowedAreaIds)find(next.accessAreas,areaId,'Área permitida');Object.assign(record,access);
      }
      const uniqueField=kind==='fleet'?'plate':kind==='vessels'?'registration':'name';if(next[kind].some(x=>x.id!==record.id&&(kind==='people'?personIdentityKey(x)===personIdentityKey(record):normalize(x[uniqueField])===normalize(record[uniqueField])))) fail('DUPLICATE','Já existe um cadastro com este identificador.');
      if(old) Object.assign(old,record);else next[kind].unshift(record);if(kind==='people')revokePersonVisits(next,record,at,actorName);result=record;entity=kind;break;
    }
    case 'ACCESS_AREA_SAVE': {
      const input=payload.record??payload;if(!input||typeof input!=='object'||Array.isArray(input))fail('VALIDATION','Setor inválido.');const old=input.id?find(next.accessAreas,input.id,'Setor'):null;
      const terms=normalizeAccessArea(input,old??{});if(next.accessAreas.some(a=>a.id!==old?.id&&normalizedIdentity(a.name)===normalizedIdentity(terms.name)))fail('DUPLICATE','Já existe um setor com este nome.');
      result={...(old??{}),...terms,id:old?.id??id('area'),createdAt:old?.createdAt??at,createdBy:old?.createdBy??actorName,updatedAt:at,updatedBy:actorName};if(old)Object.assign(old,result);else next.accessAreas.unshift(result);entity='accessArea';break;
    }
    case 'PERSON_REQUIREMENT_SAVE': {
      const input=payload.record??payload;if(!input||typeof input!=='object'||Array.isArray(input))fail('VALIDATION','Requisito inválido.');const old=input.id?find(next.personRequirements,input.id,'Requisito'):null;
      const terms=normalizePersonRequirement(next,input,at,actor,old??{});
      if(next.personRequirements.some(r=>r.id!==old?.id&&r.personId===terms.personId&&normalizedIdentity(r.name)===normalizedIdentity(terms.name)))fail('DUPLICATE','Esta pessoa já possui um requisito com este nome. Atualize o requisito existente.');
      result={id:old?.id??id('requirement'),...terms};if(old)Object.assign(old,result);else next.personRequirements.unshift(result);
      if(result.status!=='approved')for(const visit of next.visitors)if(visit.personId===result.personId&&visit.status==='authorized'&&(!result.areaIds.length||result.areaIds.includes(visit.areaId)))Object.assign(visit,{status:'revoked',revokedAt:at,revokedBy:actorName,reason:`Credencial revogada: requisito de segurança ${result.name} ${result.status==='pending'?'pendente':'revogado'}.`});
      entity='personRequirement';break;
    }
    case 'CREW_MANIFEST_SAVE': {
      const input=payload.record??payload;if(!input||typeof input!=='object'||Array.isArray(input))fail('VALIDATION','Manifesto inválido.');const old=input.id?find(next.crewManifests,input.id,'Manifesto'):null;
      result={id:old?.id??id('manifest'),...normalizeCrewManifest(next,input,at,actor,old??{})};if(old)Object.assign(old,result);else next.crewManifests.unshift(result);entity='crewManifest';break;
    }
    case 'EMERGENCY_START': {
      result={id:id('emergency'),...createEmergencyRollCall(next,payload,at,actor)};next.emergencyRollCalls.unshift(result);entity='emergencyRollCall';break;
    }
    case 'EMERGENCY_RECONCILE': {
      const old=find(next.emergencyRollCalls,payload.id,'Conferência de emergência');result=reconcileEmergencyRollCall(old,payload,at,actor);Object.assign(old,result);entity='emergencyRollCall';break;
    }
    case 'EMERGENCY_CLOSE': {
      result=find(next.emergencyRollCalls,payload.id,'Conferência de emergência');status(result,'open','A conferência já foi encerrada.');justification=optional(payload.reason,'Observação do encerramento',1000);
      const unresolved=result.people.filter(p=>!p.confirmedAt).length;if(unresolved&&!justification)fail('VALIDATION','Justifique o encerramento com pessoas ainda não localizadas.');
      Object.assign(result,{status:'closed',closedAt:at,closedBy:actorName,reason:justification,unresolvedCount:unresolved});entity='emergencyRollCall';break;
    }
    case 'ACCESS_EXIT_CORRECT': {
      const person=find(next.people,payload.personId,'Pessoa'),occurredAt=instant(payload.occurredAt??at,'Horário da saída física');justification=reason(payload);
      if(Date.parse(occurredAt)>Date.parse(at))fail('INVALID_PERIOD','A saída física não pode estar no futuro.');
      if(next.visitors.some(v=>v.status==='inside'&&(v.personId===person.id||(!v.personId&&normalizedIdentity(v.name)===normalizedIdentity(person.name)&&normalizedIdentity(v.company)===normalizedIdentity(person.company)))))fail('INVALID_TRANSITION','A pessoa possui uma entrada aberta. Registre a saída normal da visita.');
      result={id:id('accessCorrection'),type:'exit_without_entry',personId:person.id,name:person.name,company:person.company??'',gateName:gateName(payload,next),occurredAt,reason:justification,createdAt:at,createdBy:actorName};next.accessCorrections.unshift(result);entity='accessCorrection';break;
    }
    case 'RECORD_CORRECT': {
      const kind=payload.kind;const collection={visitor:'visitors',vehicle:'vehicles',stay:'stays'}[kind];if(!collection) fail('VALIDATION','Tipo de registro inválido.');
      if((role==='director'&&kind!=='visitor')||(role==='operations'&&kind!=='stay')) fail('FORBIDDEN','Seu perfil não pode corrigir este registro.');
      result=find(next[collection],payload.id,'Registro');justification=reason(payload);const changes=payload.changes;
      const previousRouting={personId:result.personId??null,areaId:result.areaId??null,stayId:result.stayId??null,responsibleUserId:result.responsibleUserId??null,substituteUserId:result.substituteUserId??null};
      const allowed={visitor:['name','company','purpose','host','notes','personId','areaId','stayId','responsibleUserId','substituteUserId'],vehicle:['driver','company','purpose','host','notes','visitorId','fleetId'],stay:['client','notes','vesselId','plannedEnd']}[kind];
      if(!changes||typeof changes!=='object'||Array.isArray(changes)||!Object.keys(changes).length||Object.keys(changes).some(k=>!allowed.includes(k))) fail('VALIDATION','A correção permite apenas vínculos, descrição e observações; horários efetivos, tarifa e valores são preservados.');
      if(kind==='stay'&&result.status==='completed'&&Object.hasOwn(changes,'client')) fail('INVALID_TRANSITION','O responsável financeiro não pode ser alterado após a geração da cobrança.');
      if(kind==='stay'&&result.contractId&&Object.hasOwn(changes,'client')&&normalize(text(changes.client,'Cliente',150))!==normalize(result.client))fail('INVALID_CONTRACT','A atracação com contrato deve preservar o cliente contratado.');
      const person=changes.personId?find(next.people,changes.personId,'Pessoa'):null,vessel=changes.vesselId?find(next.vessels,changes.vesselId,'Embarcação cadastrada'):null;if(changes.fleetId) find(next.fleet,changes.fleetId,'Veículo cadastrado');if(changes.visitorId) find(next.visitors,changes.visitorId,'Visita');
      if(kind==='visitor'&&Object.hasOwn(changes,'personId')&&!person&&result.personId)fail('VALIDATION','Preserve o vínculo da pessoa na visita.');
      if(kind==='visitor'&&result.status==='inside'&&person&&next.visitors.some(visit=>visit.id!==result.id&&visit.status==='inside'&&visit.personId===person.id)) fail('DUPLICATE','Esta pessoa já possui uma entrada em aberto.');
      if(kind==='stay'&&result.status==='active'&&vessel&&next.stays.some(stay=>stay.id!==result.id&&stay.status==='active'&&stay.vesselId===vessel.id)) fail('DUPLICATE','Esta embarcação já está atracada.');
      for(const [field,value] of Object.entries(changes)) {
        if(field==='plannedEnd') {if(result.status!=='active') fail('INVALID_TRANSITION','A previsão de saída só pode ser alterada durante a atracação.');result[field]=value?instant(value,'Saída prevista'):null;if(result[field]&&Date.parse(result[field])<Date.parse(result.start)) fail('INVALID_PERIOD','A previsão não pode preceder a chegada.');}
        else if(field.endsWith('Id')) result[field]=value?text(value,'Vínculo',150):null;
        else if(field==='notes') result[field]=optional(value,'Observação',2000);
        else result[field]=text(value,field,field==='purpose'?500:150);
      }
      if(kind==='visitor'&&person)Object.assign(result,{name:person.name,company:person.company||result.company,category:person.category??'visitor',documentLast4:person.documentLast4??result.documentLast4});
      if(kind==='visitor') {
        if(result.areaId)find(next.accessAreas,result.areaId,'Setor da visita');if(result.stayId)find(next.stays,result.stayId,'Atracação da visita');
        const areaChanged=(result.areaId??null)!==previousRouting.areaId,assignmentChanged=['responsibleUserId','substituteUserId'].some(field=>(result[field]??null)!==previousRouting[field]);
        if((areaChanged||assignmentChanged)&&!['pending','authorized'].includes(result.status))fail('INVALID_TRANSITION','A responsabilidade e o setor só podem ser alterados antes da entrada.');
        const destination=next.accessAreas.find(a=>a.id===result.areaId);
        if(areaChanged)Object.assign(result,normalizeVisitResponsibility(changes,destination??{}));else if(assignmentChanged)Object.assign(result,normalizeVisitResponsibility(result));
        if((areaChanged||assignmentChanged)&&destination?.responsibleUserId&&!result.responsibleUserId)fail('RESPONSIBLE_REQUIRED','Selecione o usuário responsável pela aprovação.');
        if((areaChanged||assignmentChanged)&&result.status==='authorized')Object.assign(result,{status:'pending',approvedAt:null,approvedBy:null,reassignedAt:at,reassignedBy:actorName});
        const routingChanged=['personId','areaId','stayId'].some(field=>(result[field]??null)!==previousRouting[field]);
        if(result.status==='inside')assertNoDuplicatePresence(next,result);
        if(routingChanged&&['authorized','inside'].includes(result.status))assertVisitEligibility(next,result,at,{entry:result.status==='inside'});
        if(result.status==='inside'&&result.personId!==previousRouting.personId) {
          if(payload.identityConfirmed!==true)fail('IDENTITY_REQUIRED','Confira o documento e confirme a identidade para corrigir a pessoa presente.');
          Object.assign(result,{identityReconfirmedAt:at,identityReconfirmedBy:actorName});
        }
      }
      if(kind==='stay'&&result.status==='active')assertReservationConflicts({...next,stays:[]},{...result,end:result.plannedEnd},result.reservationId);
      Object.assign(result,{correctedAt:at,correctedBy:actorName});entity=kind;break;
    }
  }
  const changes=auditDiff(state,next);
  if(changes.length) next.audit.unshift({id:id('audit'),at,actor:actorName,actorId:actor.id??null,role,action:command.type,entity,entityId:result?.id??entity,reason:justification||null,detail:`${command.type}: ${result?.name??result?.vesselName??result?.plate??result?.id??entity}`,changes});
  return {state:next,result};
}

/** Valida backups antes de restaurar; referências e cálculos não podem ser inventados. */
export function validateState(input) {
  if(!input||input.version!==2) fail('INVALID_BACKUP','Backup com versão incompatível.');
  const state=structuredClone(input);for(const kind of NEW_COLLECTIONS)if(!Object.hasOwn(state,kind))state[kind]=[];state.settings=validateSettings(state.settings);state.berths=list(state.berths,'Berços');
  for(const kind of COLLECTIONS) {
    if(!Array.isArray(state[kind])||state[kind].length>50000) fail('INVALID_BACKUP',`Coleção ${kind} inválida ou muito grande.`);
    const keys=new Set();for(const record of state[kind]) {
      if(!record||typeof record!=='object'||Array.isArray(record)) fail('INVALID_BACKUP','Registro inválido.');const recordId=text(record.id,'Identificador',150);if(recordId!==record.id||keys.has(recordId)) fail('INVALID_BACKUP','Identificadores inválidos ou repetidos.');keys.add(recordId);
      optional(record.notes,'Observação',2000);
      for(const field of ['correctedBy','updatedBy']) optional(record[field],field,150);
      for(const field of ['correctedAt','updatedAt']) if(record[field]!=null) instant(record[field],field);
    }
  }
  const occupied=new Set(),registrations=new Set(),vesselNames=new Set(),vesselIds=new Set(),plates=new Set(),peopleInside=new Set();
  for(const visit of state.visitors) {
    for(const f of ['name','company','purpose','host']) text(visit[f],f,f==='purpose'?500:150);
    instant(visit.requestedAt,'Solicitação');text(visit.requestedBy,'Solicitante',150);text(visit.gateName,'Portaria',100);
    const documentLast4=optional(visit.documentLast4,'Final do documento',4);if(documentLast4&&!/^\d{4}$/.test(documentLast4)) fail('INVALID_BACKUP','Final do documento inválido.');
    for(const field of ['approvedBy','rejectedBy','revokedBy','cancelledBy','checkedInBy','checkedOutBy']) optional(visit[field],field,150);
    for(const field of ['approvedAt','rejectedAt','revokedAt','cancelledAt','enteredAt','leftAt']) if(visit[field]!=null) instant(visit[field],field);
    const expected=instant(visit.expectedAt,'Previsão'),until=instant(visit.validUntil,'Validade');if(Date.parse(until)<Date.parse(expected)) fail('INVALID_BACKUP','Validade de visita inconsistente.');
    if(!['pending','authorized','inside','completed','denied','revoked','cancelled'].includes(visit.status)) fail('INVALID_BACKUP','Status de visita inválido.');
    if(['authorized','inside','completed'].includes(visit.status)) {instant(visit.approvedAt,'Autorização');text(visit.approvedBy,'Autorizador',150);}
    if(['inside','completed'].includes(visit.status)) {instant(visit.enteredAt,'Entrada');if(Date.parse(visit.enteredAt)<Date.parse(expected)||Date.parse(visit.enteredAt)>Date.parse(until)||Date.parse(visit.enteredAt)<Date.parse(visit.approvedAt)) fail('INVALID_BACKUP','Entrada de visita inconsistente.');}
    if(visit.status==='inside'&&visit.personId) {if(peopleInside.has(visit.personId)) fail('INVALID_BACKUP','Pessoa com entradas simultâneas.');peopleInside.add(visit.personId);}
    if(visit.status==='completed'&&Date.parse(instant(visit.leftAt,'Saída'))<Date.parse(visit.enteredAt)) fail('INVALID_BACKUP','Saída de visita inconsistente.');
    if(['denied','revoked','cancelled'].includes(visit.status)) text(visit.reason,'Justificativa',1000);
    if(visit.personId&&!state.people.some(p=>p.id===visit.personId)) fail('INVALID_BACKUP','Pessoa vinculada ausente.');
  }
  for(const vehicle of state.vehicles) {
    if(!/^[A-Z0-9]{5,10}$/.test(text(vehicle.plate,'Placa',15))) fail('INVALID_BACKUP','Placa inválida.');text(vehicle.driver,'Motorista',150);text(vehicle.company,'Empresa',150);text(vehicle.purpose,'Motivo',500);text(vehicle.gateName,'Portaria',100);instant(vehicle.entryAt,'Entrada');optional(vehicle.host,'Responsável',150);text(vehicle.enteredBy,'Operador da entrada',150);optional(vehicle.exitedBy,'Operador da saída',150);if(vehicle.exitAt!=null) instant(vehicle.exitAt,'Saída');
    if(!['inside','completed'].includes(vehicle.status)) fail('INVALID_BACKUP','Status de veículo inválido.');if(vehicle.status==='inside') {if(plates.has(vehicle.plate)) fail('INVALID_BACKUP','Veículo com entradas simultâneas.');plates.add(vehicle.plate);}else if(Date.parse(instant(vehicle.exitAt,'Saída'))<Date.parse(vehicle.entryAt)) fail('INVALID_BACKUP','Saída de veículo inconsistente.');
    if(vehicle.visitorId&&!state.visitors.some(v=>v.id===vehicle.visitorId)) fail('INVALID_BACKUP','Visita vinculada ausente.');if(vehicle.fleetId&&!state.fleet.some(v=>v.id===vehicle.fleetId)) fail('INVALID_BACKUP','Veículo cadastrado ausente.');
  }
  const chargeStays=new Set();
  for(const stay of state.stays) {
    text(stay.vesselName,'Embarcação',150);text(stay.registration,'Registro',100);text(stay.client,'Cliente',150);text(stay.berth,'Berço',100);instant(stay.start,'Início');instant(stay.openedAt,'Registro da atracação');text(stay.openedBy,'Operador da atracação',150);optional(stay.closedBy,'Operador do encerramento',150);if(stay.closedAt!=null) instant(stay.closedAt,'Registro do encerramento');tariffSnapshot(stay.tariff);
    if(!['active','completed'].includes(stay.status)) fail('INVALID_BACKUP','Status de atracação inválido.');
    if(stay.status==='active') {if(!state.berths.includes(stay.berth)||occupied.has(stay.berth)||registrations.has(normalize(stay.registration))||vesselNames.has(normalize(stay.vesselName))||(stay.vesselId&&vesselIds.has(stay.vesselId))) fail('INVALID_BACKUP','Ocupação de berços inconsistente.');occupied.add(stay.berth);registrations.add(normalize(stay.registration));vesselNames.add(normalize(stay.vesselName));if(stay.vesselId)vesselIds.add(stay.vesselId);if(stay.end||stay.chargeId) fail('INVALID_BACKUP','Atracação ativa com encerramento.');}
    else {instant(stay.end,'Fim');if(!state.charges.some(c=>c.id===stay.chargeId&&c.stayId===stay.id)) fail('INVALID_BACKUP','Cobrança da atracação ausente.');}
    if(stay.plannedEnd&&Date.parse(instant(stay.plannedEnd,'Saída prevista'))<Date.parse(stay.start)) fail('INVALID_BACKUP','Previsão de saída inconsistente.');
    if(stay.vesselId&&!state.vessels.some(v=>v.id===stay.vesselId)) fail('INVALID_BACKUP','Embarcação cadastrada ausente.');
    if(stay.dueDays!=null)integer(stay.dueDays,'Prazo da atracação',0,365);
    if(stay.contractId) {
      const contract=state.contracts.find(c=>c.id===stay.contractId);if(!contract)fail('INVALID_BACKUP','Contrato da atracação ausente.');
      const snapshot=contractTerms(stay.contractSnapshot);integer(stay.contractVersion,'Versão do contrato',1,contract.version);
      if(stay.contractSnapshot.version!==stay.contractVersion||normalize(snapshot.client)!==normalize(stay.client)||!snapshot.active||Date.parse(stay.start)<Date.parse(snapshot.validFrom)||Date.parse(stay.start)>=Date.parse(snapshot.validUntil)||stay.dueDays!==snapshot.dueDays||JSON.stringify(tariffSnapshot({...snapshot,version:stay.contractVersion}))!==JSON.stringify(tariffSnapshot(stay.tariff)))fail('INVALID_BACKUP','Condições contratadas da atracação inconsistentes.');
    }else if(stay.contractVersion!=null||stay.contractSnapshot!=null)fail('INVALID_BACKUP','Snapshot contratual sem contrato.');
    if(stay.reservationId&&!state.reservations.some(r=>r.id===stay.reservationId&&r.status==='arrived'&&r.stayId===stay.id))fail('INVALID_BACKUP','Reserva vinculada à atracação inconsistente.');
  }
  for(const charge of state.charges) {
    text(charge.client,'Responsável financeiro',150);text(charge.vesselName,'Embarcação da cobrança',150);optional(charge.paidBy,'Operador do recebimento',150);if(charge.paidAt!=null)instant(charge.paidAt,'Quitação');
    const stay=state.stays.find(s=>s.id===charge.stayId);if(!stay||stay.status!=='completed'||stay.chargeId!==charge.id||chargeStays.has(stay.id)) fail('INVALID_BACKUP','Vínculo da cobrança inconsistente.');chargeStays.add(stay.id);
    const calculation=calculateCharge(stay.start,stay.end,stay.tariff);if(charge.client!==stay.client||charge.vesselName!==stay.vesselName||JSON.stringify(tariffSnapshot(charge.tariff))!==JSON.stringify(tariffSnapshot(stay.tariff))||charge.start!==stay.start||charge.end!==stay.end||Object.keys(calculation).some(k=>charge[k]!==calculation[k])) fail('INVALID_BACKUP','Responsável financeiro, embarcação ou cálculo de cobrança inconsistente.');
    if((charge.contractId??null)!==(stay.contractId??null)||(charge.contractVersion??null)!==(stay.contractVersion??null)||JSON.stringify(charge.contractSnapshot??null)!==JSON.stringify(stay.contractSnapshot??null))fail('INVALID_BACKUP','Contrato da cobrança inconsistente.');
    if(charge.dueDays!=null){integer(charge.dueDays,'Prazo da cobrança',0,365);if(stay.dueDays!=null&&charge.dueDays!==stay.dueDays)fail('INVALID_BACKUP','Prazo contratado inconsistente.');if(Date.parse(charge.dueAt)!==Date.parse(charge.createdAt)+charge.dueDays*86400000)fail('INVALID_BACKUP','Vencimento não corresponde ao prazo preservado.');}
    instant(charge.createdAt,'Geração');instant(charge.dueAt,'Vencimento');if(Date.parse(charge.createdAt)<Date.parse(stay.end)||Date.parse(charge.dueAt)<Date.parse(charge.createdAt)) fail('INVALID_BACKUP','Datas da cobrança inconsistentes.');if(!['pending','partial','paid','cancelled'].includes(charge.status)||!Array.isArray(charge.payments)) fail('INVALID_BACKUP','Cobrança inválida.');
    const payments=new Set();for(const payment of charge.payments) {if(!payment||typeof payment!=='object'||Array.isArray(payment))fail('INVALID_BACKUP','Recebimento inválido.');text(payment.id,'Recebimento',150);if(payments.has(payment.id)) fail('INVALID_BACKUP','Recebimento repetido.');payments.add(payment.id);integer(payment.amountCents,'Recebimento',1);text(payment.method,'Forma de recebimento',50);optional(payment.reference,'Referência do recebimento',200);text(payment.registeredBy,'Operador do recebimento',150);optional(payment.reversedBy,'Operador do estorno',150);instant(payment.receivedAt,'Recebimento');instant(payment.registeredAt,'Registro do recebimento');if(Date.parse(payment.receivedAt)<Date.parse(charge.createdAt)||Date.parse(payment.receivedAt)>Date.parse(payment.registeredAt)) fail('INVALID_BACKUP','Data de recebimento inconsistente.');if(payment.reversedAt){instant(payment.reversedAt,'Estorno');text(payment.reversalReason,'Justificativa',1000);if(Date.parse(payment.reversedAt)<Date.parse(payment.registeredAt)) fail('INVALID_BACKUP','Data de estorno inconsistente.');}}
    if(charge.status==='cancelled') {text(charge.cancelReason,'Motivo do cancelamento',1000);instant(charge.cancelledAt,'Cancelamento');}
    const current={...charge};paymentTotals(current);if(current.paidCents>charge.totalCents||current.paidCents!==charge.paidCents||current.balanceCents!==charge.balanceCents||current.status!==charge.status||(charge.status==='cancelled'&&current.paidCents>0)) fail('INVALID_BACKUP','Saldo da cobrança inconsistente.');
  }
  for(const kind of ['people','fleet','vessels','companies']) {const keys=new Set();for(const record of state[kind]) {if(typeof record.active!=='boolean') fail('INVALID_BACKUP','Cadastro sem situação.');if(kind!=='fleet')text(record.name,'Nome do cadastro',150);else optional(record.name,'Descrição do veículo',150);if(kind==='fleet'&&!/^[A-Z0-9]{5,10}$/.test(text(record.plate,'Placa cadastrada',15))) fail('INVALID_BACKUP','Placa cadastrada inválida.');if(kind==='vessels')text(record.registration,'Registro da embarcação',100);for(const field of ['company','contact','phone','email','host','driver','type'])optional(record[field],field,200);instant(record.updatedAt,'Atualização do cadastro');text(record.updatedBy,'Operador do cadastro',150);const f=kind==='fleet'?'plate':kind==='vessels'?'registration':'name';const k=kind==='people'?personIdentityKey(record):normalize(text(record[f],'Cadastro',150));if(keys.has(k)) fail('INVALID_BACKUP','Cadastros repetidos.');keys.add(k);}}
  for(const tariff of state.tariffHistory) {tariffSnapshot(tariff.previous);tariffSnapshot(tariff.tariff);instant(tariff.changedAt,'Alteração de tarifa');text(tariff.changedBy,'Operador da tarifa',150);}
  const recordMeta=record=>{instant(record.createdAt,'Criação');text(record.createdBy,'Autor',150);if(record.updatedAt!=null&&Date.parse(instant(record.updatedAt,'Atualização'))<Date.parse(record.createdAt))fail('INVALID_BACKUP','Atualização anterior à criação.');if(record.updatedBy!=null)text(record.updatedBy,'Autor da atualização',150);};
  for(const contract of state.contracts){contractTerms(contract);integer(contract.version,'Versão do contrato',1);recordMeta(contract);instant(contract.updatedAt,'Atualização do contrato');text(contract.updatedBy,'Autor da atualização',150);}
  for(const reservation of state.reservations){
    for(const [field,label,max] of [['vesselName','Embarcação',150],['registration','Registro',100],['client','Cliente',150],['berth','Berço',100]])text(reservation[field],label,max);
    const start=instant(reservation.start,'Chegada prevista'),end=instant(reservation.end,'Saída prevista');if(Date.parse(end)<=Date.parse(start))fail('INVALID_BACKUP','Intervalo da reserva inconsistente.');recordMeta(reservation);
    if(!['confirmed','cancelled','arrived'].includes(reservation.status))fail('INVALID_BACKUP','Situação da reserva inválida.');
    if(reservation.status==='confirmed'){
      if(!state.berths.includes(reservation.berth)&&Date.parse(end)>Date.now())fail('INVALID_BACKUP','Berço de reserva futura ausente.');
      if(reservation.stayId)fail('INVALID_BACKUP','Reserva confirmada já possui atracação.');
      assertReservationConflicts(state,reservation,reservation.id);
    }else if(reservation.status==='cancelled'){text(reservation.reason,'Motivo do cancelamento',1000);instant(reservation.cancelledAt,'Cancelamento');text(reservation.cancelledBy,'Autor do cancelamento',150);if(reservation.stayId)fail('INVALID_BACKUP','Reserva cancelada vinculada a atracação.');}
    else {const stay=state.stays.find(s=>s.id===reservation.stayId&&s.reservationId===reservation.id);if(!stay||!sameVessel(stay,reservation)||normalize(stay.registration)!==normalize(reservation.registration)||normalize(stay.client)!==normalize(reservation.client)||stay.berth!==reservation.berth)fail('INVALID_BACKUP','Chegada da reserva sem atracação correspondente.');instant(reservation.arrivedAt,'Chegada da reserva');text(reservation.arrivedBy,'Autor da chegada',150);}
  }
  for(const incident of state.incidents){
    text(incident.title,'Título',150);text(incident.description,'Descrição',4000);text(incident.category,'Categoria',100);text(incident.location,'Local',150);text(incident.responsible,'Responsável',150);idList(incident.attachmentIds,'Anexos',8);recordMeta(incident);
    if(!['low','medium','high','critical'].includes(incident.severity)||!['open','in_progress','resolved'].includes(incident.status))fail('INVALID_BACKUP','Gravidade ou situação de ocorrência inválida.');
    if(!Array.isArray(incident.history)||!incident.history.length||incident.history.length>10000)fail('INVALID_BACKUP','Histórico da ocorrência inválido.');
    let previous=Date.parse(incident.createdAt);for(const entry of incident.history){if(!entry||typeof entry!=='object'||Array.isArray(entry)||!['open','in_progress','resolved'].includes(entry.status))fail('INVALID_BACKUP','Histórico da ocorrência inválido.');const when=Date.parse(instant(entry.at,'Data do histórico'));if(when<previous)fail('INVALID_BACKUP','Histórico de ocorrência fora de ordem.');previous=when;text(entry.actor,'Autor do histórico',150);text(entry.note,'Acompanhamento',2000);}
    if(incident.history.at(-1).status!==incident.status||incident.history.at(-1).at!==incident.updatedAt)fail('INVALID_BACKUP','Histórico de ocorrência não corresponde à situação atual.');
    if(incident.status==='resolved'){text(incident.resolution,'Solução',2000);instant(incident.resolvedAt,'Resolução');text(incident.resolvedBy,'Autor da resolução',150);}else optional(incident.resolution,'Solução',2000);
  }
  for(const handover of state.handovers){
    text(handover.shift,'Turno',100);text(handover.summary,'Resumo',4000);optional(handover.pending,'Pendências',4000);recordMeta(handover);for(const incidentId of idList(handover.incidentIds,'Ocorrências'))if(!state.incidents.some(i=>i.id===incidentId))fail('INVALID_BACKUP','Ocorrência da passagem de turno ausente.');
    if(!Array.isArray(handover.acknowledgements)||handover.acknowledgements.length>10000)fail('INVALID_BACKUP','Ciências da passagem de turno inválidas.');const actors=new Set();for(const acknowledgement of handover.acknowledgements){if(!acknowledgement||typeof acknowledgement!=='object'||Array.isArray(acknowledgement))fail('INVALID_BACKUP','Ciência de turno inválida.');text(acknowledgement.actor,'Autor da ciência',150);const actorKey=acknowledgement.actorId?text(acknowledgement.actorId,'Identidade da ciência',150):acknowledgement.actor;if(actors.has(actorKey))fail('INVALID_BACKUP','Ciência de turno repetida.');actors.add(actorKey);if(Date.parse(instant(acknowledgement.at,'Ciência'))<Date.parse(handover.createdAt))fail('INVALID_BACKUP','Ciência anterior à passagem de turno.');optional(acknowledgement.note,'Observação',2000);}
  }
  const settlementKeys=new Set();for(const settlement of state.settlements){
    text(settlement.client,'Cliente',150);monthValue(settlement.month);recordMeta(settlement);optional(settlement.reason,'Observação do fechamento',1000);const timezone=text(settlement.timezone,'Fuso do fechamento',100);try{new Intl.DateTimeFormat('pt-BR',{timeZone:timezone}).format();}catch{fail('INVALID_BACKUP','Fuso do fechamento inválido.');}
    if(settlement.month>=monthInTimezone(settlement.createdAt,timezone))fail('INVALID_BACKUP','Fechamento de mês ainda não encerrado.');const key=normalize(settlement.client)+':'+settlement.month;if(settlementKeys.has(key))fail('INVALID_BACKUP','Fechamento mensal repetido.');settlementKeys.add(key);
    const chargeIds=idList(settlement.chargeIds,'Cobranças',50000);if(!chargeIds.length||!Array.isArray(settlement.items)||chargeIds.length!==settlement.items.length||chargeIds.some((chargeId,index)=>settlement.items[index]?.chargeId!==chargeId))fail('INVALID_BACKUP','Itens do fechamento inconsistentes.');
    let total=0,paid=0,balance=0,cancelled=0;for(const item of settlement.items){const charge=state.charges.find(c=>c.id===item.chargeId);if(!charge||normalize(charge.client)!==normalize(settlement.client)||monthInTimezone(charge.createdAt,timezone)!==settlement.month||item.totalCents!==charge.totalCents||!['pending','partial','paid','cancelled'].includes(item.status))fail('INVALID_BACKUP','Cobrança do fechamento inconsistente.');integer(item.totalCents,'Total do item',0);integer(item.paidCents,'Recebido do item',0);integer(item.balanceCents,'Saldo do item',0);if(item.paidCents+item.balanceCents!==item.totalCents||(item.status==='pending'&&item.paidCents!==0)||(item.status==='partial'&&(item.paidCents===0||item.balanceCents===0))||(item.status==='paid'&&item.balanceCents!==0)||(item.status==='cancelled'&&item.paidCents!==0))fail('INVALID_BACKUP','Saldo preservado do fechamento inconsistente.');if(item.status==='cancelled')cancelled+=item.totalCents;else{total+=item.totalCents;paid+=item.paidCents;balance+=item.balanceCents;}}
    if(settlement.totalCents!==total||settlement.paidCents!==paid||settlement.balanceCents!==balance||settlement.cancelledCents!==cancelled||![total,paid,balance,cancelled].every(Number.isSafeInteger))fail('INVALID_BACKUP','Totais do fechamento inconsistentes.');
  }
  try {validatePhysicalAccessState(state);}catch(error){fail('INVALID_BACKUP',error.message);}
  state.audit=[];return state;
}
export function createDemoState(nowISO=new Date().toISOString()) {
  const state=createInitialState(),now=Date.parse(instant(nowISO,'Data'));const ago=h=>new Date(now-h*3600000).toISOString();
  const actor={id:'demo_admin',name:'Administrador demonstração',role:'admin'};
  let current=executeHistorical(state,{type:'SETTINGS_UPDATE',payload:{unitName:'Terminal Porto Azul · Demonstração',dailyRateCents:15000,configured:true},at:ago(80)},actor).state;
  for(const name of ['Cais A-01','Cais A-02','Cais B-01','Cais B-02']) current=executeHistorical(current,{type:'BERTH_ADD',payload:{name},at:ago(80)},actor).state;
  current=executeHistorical(current,{type:'STAY_OPEN',payload:{vesselName:'Rio Sol (fictícia)',registration:'FICT-RS-001',client:'Navegação Rio Sol (fictícia)',berth:'Cais A-01',start:ago(28)},at:ago(28)},actor).state;
  current=executeHistorical(current,{type:'STAY_OPEN',payload:{vesselName:'Estrela do Norte (fictícia)',registration:'FICT-EN-002',client:'Horizonte (fictícia)',berth:'Cais B-01',start:ago(70)},at:ago(70)},actor).state;
  current=executeHistorical(current,{type:'STAY_CLOSE',payload:{id:current.stays[0].id,end:ago(44)},at:ago(44)},actor).state;
  current=executeHistorical(current,{type:'VISITOR_REQUEST',payload:{name:'Ana Ribeiro (fictícia)',company:'Tecnoserv (fictícia)',purpose:'Manutenção preventiva',host:'Carlos · Manutenção',expectedAt:ago(2),validUntil:new Date(now+8*3600000).toISOString()},at:ago(4)},actor).state;
  return current;
}
