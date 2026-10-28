import { COLLECTIONS, createInitialState } from './domain.mjs';
import { redactValue, visibleSnapshot } from './access.mjs';
import { activeState, assertActiveCollection, RETIRED_COLLECTIONS } from './module-policy.mjs';

type Row=Record<string,any>;
export const HISTORY_DAYS=30;
const WINDOW_RULES:Record<string,{field:string;active:string[]}>= {
  visitors:{field:'requestedAt',active:['pending','authorized','inside']},
  vehicles:{field:'entryAt',active:['inside']},
  incidents:{field:'createdAt',active:['open','in_progress']},
  handovers:{field:'createdAt',active:[]},
  emergencyRollCalls:{field:'startedAt',active:['open']},accessCorrections:{field:'createdAt',active:[]},
};
function stmt(db:D1Database,sql:string,...args:unknown[]){return db.prepare(sql).bind(...args);}
function rows(value:D1Result){return value.results??[];}
function invalid(message:string):never{throw Object.assign(new Error(message),{code:'VALIDATION'});}
export function historyWindow(now=new Date().toISOString()){
  const date=new Date(now);date.setUTCHours(0,0,0,0);date.setUTCDate(date.getUTCDate()-HISTORY_DAYS);
  return {since:date.toISOString(),days:HISTORY_DAYS,auditLimit:100,complete:false};
}
export function windowState(input:Row,now=new Date().toISOString()) {
  const window=historyWindow(now),state:Row={...input,historyWindow:window};
  for(const [collection,rule] of Object.entries(WINDOW_RULES))state[collection]=(input[collection]??[]).filter((r:Row)=>rule.active.includes(r.status)||String(r[rule.field]??r.updatedAt??'')>=window.since);
  state.audit=(input.audit??[]).slice(0,window.auditLimit);
  return state;
}
export function operationalVisible(snapshot:Row,user:Row){return visibleSnapshot({...snapshot,state:windowState(snapshot.state)},user);}
export async function readOperationalSnapshot(db:D1Database){
  const window=historyWindow(),clauses:string[]=[],params:unknown[]=[];
  for(const collection of COLLECTIONS.filter(kind=>!RETIRED_COLLECTIONS.includes(kind))){
    const rule=WINDOW_RULES[collection];
    if(!rule){clauses.push('collection=?');params.push(collection);continue;}
    clauses.push(`(collection=? AND (COALESCE(json_extract(body,'$.${rule.field}'),json_extract(body,'$.updatedAt'),'')>=?${rule.active.length?` OR json_extract(body,'$.status') IN (${rule.active.map(()=>'?').join(',')})`:''}))`);
    params.push(collection,window.since,...rule.active);
  }
  const result=await db.batch([
    stmt(db,'SELECT revision FROM operational_meta WHERE id=1'),
    stmt(db,`SELECT collection,id,body FROM operational_records WHERE ${clauses.join(' OR ')} ORDER BY rowid DESC`,...params),
    stmt(db,'SELECT id,body FROM operational_settings'),
    stmt(db,'SELECT body FROM operational_audit ORDER BY at DESC,rowid DESC LIMIT 100'),
  ]);
  const state=createInitialState() as Row;
  for(const r of rows(result[1]) as Row[])if(Array.isArray(state[r.collection]))state[r.collection].push(JSON.parse(r.body));
  for(const r of rows(result[2]) as Row[])if(['settings','berths'].includes(r.id))state[r.id]=JSON.parse(r.body);
  state.audit=(rows(result[3]) as Row[]).map(r=>JSON.parse(r.body));state.historyWindow=window;
  return {state,revision:Number((rows(result[0])[0] as Row)?.revision??0)};
}
export function stateDelta(before:Row,after:Row,now=new Date().toISOString()){
  const old=windowState(before,now),next=windowState(after,now),collections:Row={},values:Row={};
  for(const kind of [...COLLECTIONS.filter(kind=>!RETIRED_COLLECTIONS.includes(kind)),'audit']){
    const previous=new Map<string,Row>((old[kind]??[]).map((r:Row)=>[r.id,r])),upsert:Row[]=[];
    for(const record of next[kind]??[]){const existing=previous.get(record.id);if(JSON.stringify(existing)!==JSON.stringify(record))upsert.push(record);previous.delete(record.id);}
    const remove=[...previous.keys()];if(upsert.length||remove.length)collections[kind]={upsert,remove};
  }
  const oldActive=activeState(old),nextActive=activeState(next);
  for(const key of ['settings','historyWindow'])if(JSON.stringify(oldActive[key])!==JSON.stringify(nextActive[key]))values[key]=nextActive[key];
  return {collections,values};
}
export async function syncState(db:D1Database,user:Row,since:number,forceReset=false,windowSince?:string|null){
  if(windowSince&&windowSince!==historyWindow().since)forceReset=true;
  const result=await db.batch([
    stmt(db,'SELECT revision FROM operational_meta WHERE id=1'),
    stmt(db,'SELECT revision,body FROM operational_changes WHERE revision>? ORDER BY revision LIMIT 251',since),
  ]),revision=Number((rows(result[0])[0] as Row)?.revision??0);
  const base={revision,user,capabilities:user.capabilities};
  if(!forceReset&&since===revision)return {...base,unchanged:true};
  const changes=(rows(result[1]) as Row[]).filter(r=>r.revision<=revision);
  if(forceReset||since>revision||changes.length>250||changes.length!==revision-since||changes.some(r=>!JSON.parse(r.body))){
    return {...operationalVisible(await readOperationalSnapshot(db),user),reset:true};
  }
  const collections:Row={},values:Row={};
  for(const change of changes){const data=JSON.parse(change.body);Object.assign(values,data.values??{});
    for(const [kind,delta] of Object.entries(data.collections??{}) as [string,Row][]){
      if(![...COLLECTIONS,'audit'].includes(kind)||RETIRED_COLLECTIONS.includes(kind))continue;
      const aggregate=collections[kind]??={upsert:new Map<string,Row>(),remove:new Set<string>()};
      for(const id of delta.remove??[]){aggregate.upsert.delete(id);aggregate.remove.add(id);}
      for(const record of delta.upsert??[]){aggregate.remove.delete(record.id);aggregate.upsert.set(record.id,record);}
    }
  }
  const caps=user.capabilities,denied=new Set<string>();
  if(!caps.auditView)denied.add('audit');
  const visible:Row={};
  for(const [kind,data] of Object.entries(collections) as [string,Row][]){
    if(denied.has(kind))continue;
    let records=[...data.upsert.values()];if(kind==='audit'&&!caps.documentView)records=records.filter((r:Row)=>r.entity!=='attachment'&&r.action!=='ATTACHMENT_UPLOAD');
    visible[kind]={upsert:redactValue(records,caps),remove:[...data.remove]};
  }
  delete values.berths;
  if(values.settings)values.settings=activeState({settings:values.settings}).settings;
  return {...base,delta:{collections:visible,values:redactValue(values,caps)}};
}
function dateValue(value:string|null){
  if(!value)return '';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T12:00:00Z'))||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value)invalid('Informe um período válido no formato AAAA-MM-DD.');
  return value;
}
function midnight(day:string,timezone:string){
  const [year,month,date]=day.split('-').map(Number),desired=Date.UTC(year,month-1,date);
  let candidate=desired;
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for(let i=0;i<4;i++){
    const part=Object.fromEntries(format.formatToParts(new Date(candidate)).map(p=>[p.type,p.value]));
    const represented=Date.UTC(+part.year,+part.month-1,+part.day,+part.hour,+part.minute,+part.second),next=desired-(represented-candidate);
    if(next===candidate)break;candidate=next;
  }
  return new Date(candidate).toISOString();
}
export async function pagedRecords(db:D1Database,user:Row,query:URLSearchParams){
  const collection=query.get('collection')??'visitors';
  assertActiveCollection(collection);
  if(![...COLLECTIONS,'audit'].includes(collection))invalid('Coleção de registros inválida.');
  if(collection==='audit'&&!user.capabilities.auditView)throw Object.assign(new Error('Seu acesso não permite consultar a auditoria.'),{code:'FORBIDDEN'});
  const page=Number(query.get('page')??1),pageSize=Number(query.get('pageSize')??20);
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)invalid('Paginação inválida. Use páginas de 1 a 100 registros.');
  const table=collection==='audit'?'operational_audit':'operational_records',where:string[]=[],args:unknown[]=[];
  if(collection!=='audit'){where.push('collection=?');args.push(collection);}
  const exact=(name:string,path=name)=>{const v=query.get(name);if(v&&v!=='all'){if(v.length>200)invalid('Filtro inválido.');where.push(`json_extract(body,'$.${path}')=?`);args.push(v);}};
  exact('status');exact('personId');exact('stayId');exact('areaId');exact('responsibleUserId');exact('gateName');exact('category');
  const q=query.get('q')??'',company=query.get('company')??'';
  if(q.length>200||company.length>200)invalid('Filtro muito longo.');
  if(q){const fields=['name','company','purpose','host','plate','driver','vesselName','client','title','detail','action','actor','registration',...(user.capabilities.documentView?['documentLast4']:[])];where.push(`instr(lower(${fields.map(f=>`COALESCE(json_extract(body,'$.${f}'),'')`).join("||' '||")}),lower(?))>0`);args.push(q);}
  if(company){where.push("instr(lower(COALESCE(json_extract(body,'$.company'),json_extract(body,'$.client'),'')),lower(?))>0");args.push(company);}
  if(collection==='audit'&&!user.capabilities.documentView)where.push("COALESCE(json_extract(body,'$.entity'),'')<>'attachment' AND COALESCE(json_extract(body,'$.action'),'')<>'ATTACHMENT_UPLOAD'");
  const timeFields:Row={visitors:'requestedAt',vehicles:'entryAt',audit:'at',accessCorrections:'createdAt',emergencyRollCalls:'startedAt'},timeField=timeFields[collection]??'updatedAt';
  const from=dateValue(query.get('from')),to=dateValue(query.get('to'));
  if(from&&to&&from>to)invalid('O início do período deve ser anterior ao fim.');
  if(from||to){const saved=await stmt(db,"SELECT body FROM operational_settings WHERE id='settings'").first<{body:string}>(),tz=saved?JSON.parse(saved.body).timezone:'America/Manaus';
    if(from){where.push(`json_extract(body,'$.${timeField}')>=?`);args.push(midnight(from,tz));}
    if(to){const following=new Date(to+'T12:00:00Z');following.setUTCDate(following.getUTCDate()+1);where.push(`json_extract(body,'$.${timeField}')<?`);args.push(midnight(following.toISOString().slice(0,10),tz));}
  }
  const predicate=where.length?' WHERE '+where.join(' AND '):'',result=await db.batch([
    stmt(db,`SELECT COUNT(*) AS total FROM ${table}${predicate}`,...args),
    stmt(db,`SELECT body FROM ${table}${predicate} ORDER BY COALESCE(json_extract(body,'$.${timeField}'),'') DESC,rowid DESC LIMIT ? OFFSET ?`,...args,pageSize,(page-1)*pageSize),
    stmt(db,'SELECT revision FROM operational_meta WHERE id=1'),
  ]);
  const total=Number((rows(result[0])[0] as Row).total);
  return {rows:redactValue((rows(result[1]) as Row[]).map(r=>JSON.parse(r.body)),user.capabilities),total,page,pageSize,totalPages:Math.ceil(total/pageSize),revision:Number((rows(result[2])[0] as Row)?.revision??0)};
}
