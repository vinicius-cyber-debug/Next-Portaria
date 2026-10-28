import {can as baseCan} from './domain.mjs';
import { activeState, RETIRED_CAPABILITIES } from './module-policy.mjs';

export const CAPABILITY_DEFINITIONS = [
  {key:'documentView',label:'Ver documentos e anexos',description:'Final do documento, contatos e arquivos de ocorrências.'},
  {key:'dataExport',label:'Exportar e imprimir dados',description:'CSV, crachás e listas operacionais.'},
  {key:'exceptionApprove',label:'Executar exceções justificadas',description:'Correções operacionais justificadas, dentro do perfil base.'},
  {key:'auditView',label:'Consultar auditoria',description:'Histórico de ações e alterações antes e depois.'},
  {key:'gateOperate',label:'Operar portaria',description:'Emitir crachás, registrar entradas e saídas, dentro do perfil base.'},
  {key:'incidentManage',label:'Gerenciar ocorrências e turnos',description:'Registrar incidentes, anexar evidências e passar o turno.'},
  {key:'accessManage',label:'Gerenciar áreas e requisitos de acesso',description:'Setores, permissões de área e validação de segurança, dentro do perfil base.'},
  {key:'emergencyManage',label:'Conferir pessoas em emergência',description:'Abrir, reconciliar e encerrar conferências físicas de pessoas presentes.'},
];
const keys=CAPABILITY_DEFINITIONS.map(d=>d.key);
const enabled = {
  admin:keys,
  director:['documentView','dataExport','exceptionApprove','auditView','incidentManage','accessManage','emergencyManage'],
  gate:['documentView','dataExport','gateOperate','incidentManage','emergencyManage'],
  operations:['documentView','dataExport','exceptionApprove','incidentManage','accessManage','emergencyManage'],
  finance:[],
  reader:[],
};
export function defaultCapabilities(role){return Object.fromEntries(keys.map(key=>[key,(enabled[role]??[]).includes(key)]));}
export function effectiveCapabilities(user,overrides={}) {
  const defaults=defaultCapabilities(user.role);
  if(user.status!=='active')return Object.fromEntries(keys.map(k=>[k,false]));
  if(user.role==='admin')return defaults;
  return {...defaults,...Object.fromEntries(Object.entries(overrides).filter(([key,value])=>keys.includes(key)&&typeof value==='boolean'))};
}
export function validateOverrides(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([key,v])=>![...keys,...RETIRED_CAPABILITIES].includes(key)||typeof v!=='boolean'))throw Object.assign(new Error('Permissões inválidas. Selecione somente as opções da lista.'),{code:'VALIDATION'});
  return {...value};
}
const commandCapability={
  VISITOR_CHECKIN:'gateOperate',VISITOR_CHECKOUT:'gateOperate',VEHICLE_ENTER:'gateOperate',VEHICLE_EXIT:'gateOperate',
  RECORD_CORRECT:'exceptionApprove',ACCESS_EXIT_CORRECT:'exceptionApprove',
  INCIDENT_CREATE:'incidentManage',INCIDENT_UPDATE:'incidentManage',SHIFT_HANDOVER:'incidentManage',SHIFT_ACKNOWLEDGE:'incidentManage',
  ACCESS_AREA_SAVE:'accessManage',PERSON_REQUIREMENT_SAVE:'accessManage',
  EMERGENCY_START:'emergencyManage',EMERGENCY_RECONCILE:'emergencyManage',EMERGENCY_CLOSE:'emergencyManage',
};
export function canWithCapabilities(user,type) {
  if(!user||user.status!=='active'||!baseCan(user.role,type))return false;
  const caps=user.capabilities??defaultCapabilities(user.role),key=commandCapability[type];
  if(key&&!caps[key])return false;
  return true;
}
const privateFinancial=new Set(['dailyRateCents','totalCents','paidCents','balanceCents','cancelledCents','amountCents','tariff','previous','payments','paidAt','paidBy','contractVersion']);
const privateDocuments=new Set(['documentLast4','email','phone','contact','attachmentIds','restrictions']);
/** O servidor retira os campos antes de enviá-los; esconder a tela não é a autorização. */
export function redactValue(value,capabilities) {
  if(Array.isArray(value))return value.map(v=>redactValue(v,capabilities));
  if(!value||typeof value!=='object')return value;
  const requirement=Object.hasOwn(value,'personId')&&Array.isArray(value.areaIds)&&Object.hasOwn(value,'reviewedAt');
  return Object.fromEntries(Object.entries(value).filter(([key])=>!(!capabilities.financialView&&privateFinancial.has(key))&&!(!capabilities.documentView&&(privateDocuments.has(key)||(requirement&&key==='notes')))).map(([key,v])=>[key,redactValue(v,capabilities)]));
}
export function visibleSnapshot(snapshot,user) {
  const caps=user.capabilities??effectiveCapabilities(user),state=activeState(redactValue(snapshot.state,caps));
  if(!caps.auditView)state.audit=[];
  else if(!caps.documentView)state.audit=state.audit.filter(event=>event.entity!=='attachment'&&event.action!=='ATTACHMENT_UPLOAD');
  state.financialRestricted=!caps.financialView;state.documentRestricted=!caps.documentView;
  return {...snapshot,state,user,capabilities:caps};
}
