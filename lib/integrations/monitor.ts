import {IdSecureReader} from './idsecure.ts';
import type {Database,MediaContext} from '../persistence/contracts.ts';
import {IntegrationError} from './contracts.ts';

type Raw=Record<string,unknown>;
export type MonitorEvent={id:string;sourceUserId:string|null;deviceId:string;device:string;area:string;name:string;occurredAt:string;eventCode:number;eventName:string;kind:'authorized'|'pending'|'denied'|'unidentified'|'other';passageConfirmed:false};
type Person={id:string;name:string;directory:{recordId:string};directoryPhoto?:{sha256:string}};
type Reader={sourceId:string;readMonitor:()=>Promise<Raw[]>};
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','Vary':'Cookie','X-Content-Type-Options':'nosniff'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers});
function text(value:unknown,max:number,fallback=''){if(value==null)return fallback;if(typeof value!=='string'||value.length>max)throw new IntegrationError('invalid_input');return value.trim()||fallback;}
function identifier(value:unknown,optional=false){if(optional&&(value==null||value===0||value==='0'))return null;const id=String(value??'');if(!/^\d{1,20}$/.test(id)||BigInt(id)<BigInt(1)||typeof value==='number'&&!Number.isSafeInteger(value))throw new IntegrationError('invalid_input');return BigInt(id).toString();}
export function monitorTime(value:unknown){
 // ASP.NET JSON milliseconds already represent UTC; do not subtract the displayed offset twice.
 const match=typeof value==='string'?value.match(/^\/Date\((-?\d{1,14})(?:[+-]\d{4})?\)\/$/):null;
 const milliseconds=match?Number(match[1]):typeof value==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;
 if(!Number.isSafeInteger(milliseconds)||milliseconds<Date.UTC(2000,0,1)||milliseconds>Date.now()+86400000)throw new IntegrationError('invalid_input');return new Date(milliseconds).toISOString();
}
/** Only event metadata. CPF, card values, camera addresses and arbitrary info are discarded. */
export function monitorEvent(row:Raw):MonitorEvent{
 const eventCode=Number(row.eventCode);if(!Number.isSafeInteger(eventCode)||eventCode<0||eventCode>100000)throw new IntegrationError('invalid_input');
 return {id:identifier(row.idLog)!,sourceUserId:identifier(row.idUser,true),deviceId:identifier(row.idDevice)!,device:text(row.device,150,'Equipamento sem nome'),area:text(row.area,150,'Área não informada'),name:text(row.name,150,'Pessoa não identificada'),occurredAt:monitorTime(row.time),eventCode,eventName:text(row.eventName,150,'Evento informado pela central'),kind:eventCode===7?'authorized':eventCode===8?'pending':eventCode===6?'denied':eventCode===3?'unidentified':'other',passageConfirmed:false};
}

/** Shared bounded polling cache per process; the browser never receives source credentials. No writes. */
export class IdSecureMonitor{
 private readonly db:Database;private readonly load:()=>Promise<Reader>;private reader?:Reader;
 private events:MonitorEvent[]=[];private lastSuccessAt:string|null=null;private nextAttempt=0;private inFlight:Promise<void>|null=null;
 private sourceId:string|null=null;
 private status:'unconfigured'|'connected'|'offline'|'authentication'|'invalid'='unconfigured';
 constructor(db:Database,configPath:string,load?:()=>Promise<Reader>){this.db=db;this.load=load??(()=>IdSecureReader.fromFile(configPath));}
 private async refresh(){
  if(this.inFlight)return this.inFlight;if(Date.now()<this.nextAttempt)return;
  this.inFlight=(async()=>{try{
   this.reader??=await this.load();const rows=await this.reader.readMonitor();
   // The central repeats a log for each linked camera. Those camera fields are
   // discarded and identical events collapse; conflicting identities remain invalid.
   const seen=new Map<string,MonitorEvent>();
   for(const event of rows.map(monitorEvent)){const key=event.deviceId+':'+event.id,previous=seen.get(key);if(previous&&JSON.stringify(previous)!==JSON.stringify(event))throw new IntegrationError('invalid_input');seen.set(key,event);}
   const events=[...seen.values()];
   events.sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt)||(BigInt(a.id)>BigInt(b.id)?-1:1));
   this.events=events.slice(0,50);this.sourceId=this.reader.sourceId;this.lastSuccessAt=new Date().toISOString();this.status='connected';this.nextAttempt=Date.now()+3000;
  }catch(error){
   const kind=(error as {kind?:string;code?:string});
   this.status=kind.code==='ENOENT'?'unconfigured':kind.kind==='authentication'?'authentication':kind.kind==='invalid_input'?'invalid':'offline';
   this.nextAttempt=Date.now()+(this.status==='authentication'||this.status==='unconfigured'?60000:10000);this.reader=undefined;
  }finally{this.inFlight=null;}})();
  return this.inFlight;
 }
 async handle(request:Request,context:MediaContext){
  if(request.method!=='GET')return json({error:{code:'METHOD_NOT_ALLOWED',message:'Método não permitido.'}},405);
  if(context.user.status!=='active'||!context.user.capabilities?.documentView)return json({error:{code:'FORBIDDEN',message:'A consulta exige permissão de documentos.'}},403);
  await this.refresh();
  // Check permission again after any network wait, including logout/revocation during the read.
  const user=await context.authorize(this.db);if(user.status!=='active'||!user.capabilities?.documentView)return json({error:{code:'FORBIDDEN',message:'A consulta exige permissão de documentos.'}},403);
  const ids=[...new Set(this.events.map(event=>event.sourceUserId).filter((id):id is string=>id!==null))];
  const people=ids.length&&this.sourceId?await this.db.prepare(`SELECT id,body FROM operational_records WHERE collection='people' AND json_extract(body,'$.directory.sourceId')=? AND json_extract(body,'$.directory.recordId') IN (${ids.map(()=>'?').join(',')})`).bind(this.sourceId,...ids).all<{id:string;body:string}>():{results:[]};
  const mapping=new Map<string,Person>();for(const row of people.results){const person=JSON.parse(row.body) as Person;mapping.set(person.directory.recordId,person);}
  const events=this.events.map(event=>{const person=event.sourceUserId?mapping.get(event.sourceUserId):undefined;return {id:event.deviceId+':'+event.id,device:event.device,area:event.area,name:person?.name??event.name,occurredAt:event.occurredAt,eventCode:event.eventCode,eventName:event.eventName,kind:event.kind,passageConfirmed:false,personId:person?.id??null,photoUrl:person?.directoryPhoto?'/api/people/'+encodeURIComponent(person.id)+'/photo?v='+encodeURIComponent(person.directoryPhoto.sha256):null};});
  return json({source:'iDSecure',status:this.status,lastSuccessAt:this.lastSuccessAt,pollIntervalMs:3000,events,passageEvidence:'not_validated'});
 }
}
