import { createInitialState, execute, validateState } from '../lib/domain.mjs';
import { defaultCapabilities } from '../lib/access.mjs';

export const DEMO_USERS = [
  {id:'demo_marina',name:'Marina Rocha · demonstração',email:'marina@example.test',role:'admin',status:'active'},
  {id:'demo_rafael',name:'Rafael Moura · demonstração',email:'rafael@example.test',role:'director',status:'active'},
  {id:'demo_luana',name:'Luana Mendes · demonstração',email:'luana@example.test',role:'gate',status:'active'},
].map(user=>({...user,capabilities:defaultCapabilities(user.role),mustChangePassword:false}));

/** Synthetic records are rebuilt for each browser session; no account or database exists. */
export function createDemoSeed(now=new Date().toISOString()) {
  const origin=Date.parse(now),at=hours=>new Date(origin+hours*3_600_000).toISOString();
  const actor=DEMO_USERS[0];
  let state=createInitialState();
  function apply(type,payload,hours=-1) {
    const outcome=execute(state,{type,payload,at:at(hours)},actor);
    state=outcome.state;
    return outcome.result;
  }
  apply('SETTINGS_UPDATE',{unitName:'Unidade Aurora · demonstração',timezone:'America/Manaus',gateNames:['Portaria principal','Portaria de serviços'],visitorOverstayHours:8},-168);
  const reception=apply('ACCESS_AREA_SAVE',{name:'Administrativo',restricted:false,active:true,responsibleUserId:actor.id,substituteUserId:DEMO_USERS[1].id},-168);
  const warehouse=apply('ACCESS_AREA_SAVE',{name:'Centro de distribuição',restricted:false,active:true,responsibleUserId:actor.id,substituteUserId:DEMO_USERS[1].id},-168);
  const restricted=apply('ACCESS_AREA_SAVE',{name:'Sala de manutenção',restricted:true,active:true,responsibleUserId:actor.id},-168);
  const names=['Ana Beatriz Costa','Bruno Azevedo','Camila Torres','Diego Santos','Elisa Ramos','Felipe Lima','Gabriela Duarte','Henrique Alves','Isabela Martins','João Viana','Karina Souza','Lucas Nogueira','Mariana Freitas','Nicolas Barros','Olívia Andrade','Pedro Batista'];
  const companies=['Aurora Serviços (fictícia)','Horizonte Logística (fictícia)','Norte Suprimentos (fictícia)','Equipe interna (fictícia)'];
  for(const name of companies)apply('MASTER_SAVE',{kind:'companies',record:{name,active:true,notes:'Empresa fictícia da demonstração.'}},-168);
  const people=names.map((name,index)=>apply('MASTER_SAVE',{kind:'people',record:{name,company:companies[index%companies.length],host:'Marina Rocha',category:index%4===0?'employee':index%4===1?'contractor':index%4===2?'supplier':'visitor',securityStatus:'cleared',active:true,allowedAreaIds:index===3?[restricted.id]:[],notes:'Pessoa e dados inteiramente fictícios.'}},-168));
  for(let index=0;index<people.length;index++) {
    const person=people[index],historical=index>=11&&index<=14,day=historical?-(index-10)*24:0,area=index===3?restricted: index%2?warehouse:reception;
    const visit=apply('VISITOR_REQUEST',{personId:person.id,name:person.name,company:person.company,host:'Marina Rocha',purpose:['Reunião com a equipe administrativa','Entrega programada de materiais','Inspeção e manutenção preventiva','Atendimento à equipe da unidade'][index%4],areaId:area.id,gateName:index%2?'Portaria de serviços':'Portaria principal',expectedAt:at(day+(historical?-3:index>=8?1:-3)),validUntil:at(day+8)},day-4);
    if(index<8||historical)apply('VISITOR_APPROVE',{id:visit.id},day-3.5);
    if(index<5||historical)apply('VISITOR_CHECKIN',{id:visit.id,identityConfirmed:true,gateName:visit.gateName},day-(index%3+1)*0.5);
    if(historical)apply('VISITOR_CHECKOUT',{id:visit.id},day-0.1);
  }
  apply('PERSON_REQUIREMENT_SAVE',{personId:people[1].id,name:'Integração de segurança',status:'approved',validUntil:at(24*12),areaIds:[warehouse.id],notes:'Conferência fictícia para apresentação.'},-12);
  apply('PERSON_REQUIREMENT_SAVE',{personId:people[15].id,name:'Treinamento de acesso à manutenção',status:'pending',validUntil:null,areaIds:[restricted.id]},-2);
  for(let index=0;index<6;index++) {
    const person=people[index],fleet=apply('MASTER_SAVE',{kind:'fleet',record:{plate:`FIC${index+1}D2${index}`,name:['Utilitário de manutenção','Veículo de apoio','Caminhão de entrega'][index%3],driver:person.name,company:person.company,active:true}},-48);
    const vehicle=apply('VEHICLE_ENTER',{plate:fleet.plate,fleetId:fleet.id,driver:person.name,driverPersonId:person.id,company:person.company,purpose:'Apoio à operação · exemplo fictício',host:'Marina Rocha',gateName:index%2?'Portaria de serviços':'Portaria principal'},index<4?-0.8-index*0.3:-24);
    if(index>=4)apply('VEHICLE_EXIT',{id:vehicle.id},-23);
  }
  const first=apply('INCIDENT_CREATE',{title:'Iluminação do acesso lateral',description:'Uma luminária está intermitente. A manutenção foi avisada e o acesso segue acompanhado pela equipe.',category:'Infraestrutura',severity:'medium',location:'Portaria de serviços',responsible:'Equipe de manutenção',attachmentIds:[]},-4);
  apply('INCIDENT_UPDATE',{id:first.id,status:'in_progress',note:'Equipe de manutenção acionada.'},-3);
  apply('INCIDENT_CREATE',{title:'Atualizar sinalização da recepção',description:'Revisar a orientação de visitantes na recepção durante a troca de turno.',category:'Operação',severity:'low',location:'Recepção',responsible:'Marina Rocha',attachmentIds:[]},-2);
  const solved=apply('INCIDENT_CREATE',{title:'Leitor de crachá conferido',description:'Teste preventivo do leitor de acesso.',category:'Equipamentos',severity:'low',location:'Portaria principal',responsible:'Equipe de apoio',attachmentIds:[]},-26);
  apply('INCIDENT_UPDATE',{id:solved.id,status:'resolved',resolution:'Leitura conferida e funcionamento normal.'},-25);
  apply('SHIFT_HANDOVER',{shift:'Turno da manhã',summary:'Operação acompanhada, entregas programadas e equipe de apoio a postos.',pending:'Acompanhar manutenção da iluminação lateral.',incidentIds:[first.id]},-1);
  const checked=validateState(state);
  checked.audit=state.audit;
  return checked;
}
