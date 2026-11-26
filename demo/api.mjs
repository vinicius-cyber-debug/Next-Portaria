import { execute } from '../lib/domain.mjs';
import { CAPABILITY_DEFINITIONS, defaultCapabilities, visibleSnapshot } from '../lib/access.mjs';
import { assertActiveCollection } from '../lib/module-policy.mjs';
import { assertVisitEligibility } from '../lib/physical-access.mjs';
import { createDemoSeed, DEMO_USERS } from './seed.mjs';
import {jpegDimensions} from '../lib/visitor-photo.mjs';
import {demoMonitor} from './monitor.mjs';
import {allowedReportColumns,getReportDefinition,projectReportRecord,reportCsv} from '../lib/report-catalog.mjs';

const ORIGIN='https://demo.next-portaria.invalid';
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const error=(message='Esta ação não está disponível na demonstração. Nenhum dado foi enviado.',status=400,code='DEMO_ONLY')=>json({error:{code,message}},status);
const normalize=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const clone=value=>structuredClone(value);

function filteredRecords(state,query,collection,report) {
  assertActiveCollection(collection);
  if(!Array.isArray(state[collection]))throw new Error('Coleção de demonstração inválida.');
  let rows=[...state[collection]];
  for(const name of ['status','personId','areaId','gateName','category','severity','shift','fleetId']) {
    const value=query.get(name);
    if(value&&value!=='all')rows=rows.filter(row=>row[name]===value);
  }
  const q=normalize(query.get('q')),company=normalize(query.get('company'));
  if(q)rows=rows.filter(row=>normalize(Object.values(row).filter(value=>typeof value!=='object').join(' ')).includes(q));
  if(company)rows=rows.filter(row=>normalize(row.company).includes(company));
  const dateOf=report? row=>String(row[report.dateField]??'') : row=>row.requestedAt||row.entryAt||row.startedAt||row.createdAt||row.updatedAt||row.at||'';
  const from=query.get('from'),to=query.get('to');
  if(from||to) {
    const format=new Intl.DateTimeFormat('sv-SE',{timeZone:state.settings.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
    rows=rows.filter(row=>{
      const at=new Date(dateOf(row));
      if(Number.isNaN(+at))return false;
      const day=format.format(at);
      return (!from||day>=from)&&(!to||day<=to);
    });
  }
  return rows.sort((a,b)=>dateOf(b).localeCompare(dateOf(a))||a.id.localeCompare(b.id));
}

/** A closed API emulator: every response is local, including unknown or absolute URLs. */
export function createDemoApi({now=()=>new Date().toISOString(),origin=ORIGIN}={}) {
  let state=createDemoSeed(now()),revision=1;
  const monitorStartedAt=Date.parse(now());
  const photos=new Map();
  const actor=clone(DEMO_USERS[0]),passes=new Map(),readNotices=new Set(),commands=new Map();
  const snapshot=()=>visibleSnapshot({state,revision},actor);
  const notices=()=>state.visitors.filter(visit=>visit.status==='pending').map(visit=>({id:`demo_notice_${visit.id}`,kind:'visitor_pending',entityId:visit.id,section:'visitors',title:'Solicitação aguardando autorização',description:`${visit.name} · ${visit.purpose}`,createdAt:visit.requestedAt,readAt:readNotices.has(`demo_notice_${visit.id}`)?now():null}));
  async function request(input,init={}) {
    try {
      const signal=init.signal??(input instanceof Request?input.signal:undefined);
      if(signal?.aborted)throw new DOMException('A consulta foi cancelada.','AbortError');
      const raw=input instanceof Request?input.url:String(input),url=new URL(raw,origin);
      if(url.origin!==origin||!url.pathname.startsWith('/api/'))return error('A demonstração não acessa serviços externos ou APIs reais.',404);
      const method=(init.method??(input instanceof Request?input.method:'GET')).toUpperCase();
      const rawBody=init.body??(input instanceof Request&&method!=='GET'?await input.text():undefined);
      const body=typeof rawBody==='string'&&rawBody?JSON.parse(rawBody):{};
      const path=url.pathname.slice(4),query=url.searchParams;
      if(path.startsWith('/exit-access/'))return error('Setores e liberações de saída estão disponíveis na instalação PostgreSQL. Esta demonstração não se conecta às catracas.',503);
      if(method==='GET'&&path==='/integrations/idsecure/monitor')return json(demoMonitor(state,now(),monitorStartedAt));
      if(method==='POST'&&path==='/visitor-photos'){
        if(!(rawBody instanceof FormData))return error('Selecione a foto capturada.');const file=rawBody.get('file');if(!(file instanceof File)||file.type!=='image/jpeg')return error('Use uma foto JPEG.');
        const bytes=new Uint8Array(await file.arrayBuffer());jpegDimensions(bytes);const id='attachment_'+crypto.randomUUID(),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
        const parts=[];for(let i=0;i<bytes.length;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,i+8192)));photos.set(id,{sha256,url:'data:image/jpeg;base64,'+btoa(parts.join(''))});revision++;
        return json({attachment:{id,name:'Foto fictícia em memória',type:'image/jpeg',size:file.size},revision,demo:true});
      }
      if(method==='GET'&&path==='/session')return json({user:clone(actor),capabilities:actor.capabilities,environment:'demo',demo:true});
      if(method==='GET'&&path==='/state')return json(snapshot());
      if(method==='GET'&&path==='/sync')return json(Number(query.get('since'))===revision?{revision,user:clone(actor),capabilities:actor.capabilities,unchanged:true}:{...snapshot(),reset:true});
      if(method==='GET'&&path==='/records') {
        const visible=snapshot().state, collection=query.get('collection')||'visitors', report=getReportDefinition(collection);
        if(query.get('report')==='true'&&!report)return error('Tipo de relatório inválido.');
        const isReport=query.get('report')==='true', rows=filteredRecords(visible,query,collection,isReport?report:null),page=Number(query.get('page')||1),pageSize=Number(query.get('pageSize')||20);
        if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)return error('Paginação inválida.');
        const slice=rows.slice((page-1)*pageSize,page*pageSize);
        return json({rows:isReport?reportRows(visible,collection,slice,allowedReportColumns(report,actor.capabilities)):slice,total:rows.length,totalPages:Math.ceil(rows.length/pageSize),page,pageSize});
      }
      if(method==='GET'&&path==='/approvers')return json({users:clone(DEMO_USERS.filter(user=>['admin','director'].includes(user.role)))});
      if(method==='GET'&&path==='/users')return json({users:clone(DEMO_USERS),invites:[]});
      if(method==='GET'&&path==='/access')return json({definitions:CAPABILITY_DEFINITIONS,users:DEMO_USERS.map(user=>({...clone(user),overrides:{}})),defaults:Object.fromEntries(['admin','director','gate','operations','reader'].map(role=>[role,defaultCapabilities(role)]))});
      if(method==='GET'&&path==='/notifications') {const notifications=notices();return json({notifications,unreadCount:notifications.filter(notice=>!notice.readAt).length});}
      if(method==='POST'&&path==='/notifications/read') {if(!notices().some(notice=>notice.id===body.id))return error('Aviso não encontrado.',404);readNotices.add(body.id);return json({ok:true});}
      if(method==='GET'&&path==='/continuity')return json({config:{backupEnabled:false,everyHours:24,retentionDays:30,notificationsEnabled:true,noticeKinds:['visitor_pending'],recipientRoles:['admin','director']},backups:[],storageAvailable:false,automation:{enabled:false},notificationSummary:{active:notices().length},demo:true});
      if(method==='POST'&&path==='/commands') {
        const signature=JSON.stringify({type:body.type,payload:body.payload??{}}),existing=body.idempotencyKey?commands.get(body.idempotencyKey):null;
        if(existing)return existing.signature===signature?json({...snapshot(),result:clone(existing.result),demo:true}):error('Essa solicitação já foi usada com outros dados.',409,'CONFLICT');
        if(body.revision!==revision)return error('A demonstração foi atualizada. Revise os dados e tente novamente.',409,'CONFLICT');
        const payload={...(body.payload??{})},photo=payload.photoAttachmentId?photos.get(payload.photoAttachmentId):null;
        if(payload.visitorPhoto)return error('Use uma foto capturada nesta demonstração.');
        if(payload.photoAttachmentId&&!photo)return error('Foto não encontrada nesta aba.');
        if(photo)payload.visitorPhoto={attachmentId:payload.photoAttachmentId,sha256:photo.sha256};
        const outcome=execute(state,{type:body.type,payload,at:now()},actor);
        if(photo)outcome.result.demoPhotoUrl=photo.url;
        state=outcome.state;revision++;
        const response={...snapshot(),result:outcome.result,demo:true};
        if(body.idempotencyKey)commands.set(body.idempotencyKey,{signature,result:clone(outcome.result)});
        return json(response);
      }
      if(method==='POST'&&path==='/passes/issue') {
        const visitor=state.visitors.find(visit=>visit.id===body.visitorId);
        if(!visitor||!['authorized','inside'].includes(visitor.status))return error('Selecione uma visita autorizada ou presente.');
        assertVisitEligibility(state,visitor,now());
        for(const [key,pass] of passes)if(pass.visitorId===visitor.id)passes.delete(key);
        const pass={id:`demo_pass_${crypto.randomUUID()}`,visitorId:visitor.id,code:`PGV1.demo_${crypto.randomUUID()}`,expiresAt:visitor.validUntil,issuedAt:now()};
        passes.set(pass.code,pass);return json({pass:clone(pass),demo:true});
      }
      if(method==='POST'&&path==='/passes/lookup') {
        const pass=passes.get(body.code),visitor=pass?state.visitors.find(visit=>visit.id===pass.visitorId):null;
        if(!pass||!visitor||!['authorized','inside'].includes(visitor.status))return error('Emita um crachá nesta demonstração antes de consultar o código.',404);
        assertVisitEligibility(state,visitor,now());return json({pass:clone(pass),visitor:clone(visitor),demo:true});
      }
      if(method==='GET'&&path==='/exports') {
        const visible=snapshot().state,kind=query.get('kind')||'visitors',report=getReportDefinition(kind);
        if(!report)return error('Tipo de relatório inválido.');
        const columns=allowedReportColumns(report,actor.capabilities);
        const csv=reportCsv(columns,reportRows(visible,kind,filteredRecords(visible,query,kind,report),columns));
        return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Cache-Control':'no-store'}});
      }
      return error();
    }catch(cause) {
      if(cause?.name==='AbortError')throw cause;
      return error(cause instanceof Error?cause.message:'Não foi possível concluir a ação de demonstração.',400,cause?.code||'DEMO_ONLY');
    }
  }
  return {
    request,
    reset(){state=createDemoSeed(now());revision=1;passes.clear();readNotices.clear();commands.clear();},
  };
}

function reportRows(state,collection,rows,columns) {
  const areas=new Map(state.accessAreas.map(area=>[area.id,area.name]));
  return rows.map(row=>projectReportRecord(collection,row,columns,areas));
}
