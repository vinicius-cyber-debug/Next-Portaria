import {createHash,randomUUID} from 'node:crypto';
import type {PostgresDatabase} from '../persistence/postgres.ts';
import type {ObjectStore} from '../persistence/contracts.ts';
import {createInitialState,COLLECTIONS,validateState} from '../domain.mjs';
import {stateDelta} from '../state-sync.ts';
import type {DirectoryPerson,IdSecureReader} from './idsecure.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Existing domain API uses heterogeneous operational JSON snapshots.
type Row=Record<string,any>;
export type ImportedPerson=DirectoryPerson&{photo?:{objectKey:string;size:number;sha256:string;contentType:string}|null};
const actor='Integração iDSecure (somente leitura)';
function revokeAuthorization(record:Row,at:string){if(record.authorization?.status==='active')record.authorization={...record.authorization,status:'revoked',revokedAt:at,revokedBy:actor,reason:'Origem inativa, ausente ou bloqueada. Nova autorização local exige revisão.'};}
export function importedPersonId(sourceId:string,nativeId:string){return 'people_ids_'+createHash('sha256').update(sourceId+'\0'+nativeId).digest('hex').slice(0,32);}
/** Match immutable source identity only. Never merge by name or grant local access. */
export function mergeDirectory(state:Row,sourceId:string,people:ImportedPerson[],at:string){
 const next=structuredClone(state),seen=new Set<string>(),changes:Row[]=[];
 let created=0,updated=0,missing=0;
 for(const person of people){
  if(seen.has(person.nativeId))throw Error('Identidade de origem repetida.');seen.add(person.nativeId);
  if(person.visitor)throw Error('O diretório deve conter somente pessoas, sem visitantes.');
  const matches=next.people.filter((row:Row)=>row.directory?.sourceId===sourceId&&row.directory?.nativeId===person.nativeId);
  if(matches.length>1)throw Error('Vínculo local de origem repetido.');
  const old=matches[0],id=old?.id??importedPersonId(sourceId,person.nativeId);
  if(!old&&next.people.some((row:Row)=>row.id===id))throw Error('Identificador local em conflito.');
  const directory={sourceId,nativeId:person.nativeId,recordId:person.recordId,registration:person.registration,inactive:person.inactive,blocked:person.blocked,missing:false};
  const record:Row=old?{...old,directory}:{id,name:person.name,company:'Cadastro iDSecure',category:'employee',active:!person.inactive,securityStatus:person.blocked?'blocked':'pending',documentLast4:person.documentLast4,restrictions:'',allowedAreaIds:[],directory};
  if(person.inactive||person.blocked)revokeAuthorization(record,at);
  // Keep reviewed local identity/company/security/authorization. Source flags always remain effective.
  if(person.photo!==undefined)record.directoryPhoto=person.photo;
  if(old&&JSON.stringify({...old,updatedAt:null,updatedBy:null})===JSON.stringify({...record,updatedAt:null,updatedBy:null}))continue;
  record.updatedAt=at;record.updatedBy=actor;
  if(old)Object.assign(old,record);else next.people.push(record);
  changes.push({kind:'people',id,before:state.people.find((row:Row)=>row.id===id)??null,after:structuredClone(record)});
  if(old)updated++;else created++;
 }
 for(const record of next.people){
  if(record.directory?.sourceId!==sourceId||seen.has(record.directory.nativeId)||record.directory.missing)continue;
  const before=structuredClone(record);record.directory={...record.directory,missing:true};revokeAuthorization(record,at);record.updatedAt=at;record.updatedBy=actor;missing++;
  changes.push({kind:'people',id:record.id,before,after:structuredClone(record)});
 }
 // Revoke outstanding individual credentials too; never fabricate exit for existing presences.
 for(const visit of next.visitors){
  const person=next.people.find((p:Row)=>p.id===visit.personId);
  if(!['pending','authorized'].includes(visit.status)||!person||!(person.directory?.inactive||person.directory?.blocked||person.directory?.missing))continue;
  const before=structuredClone(visit);Object.assign(visit,{status:'revoked',revokedAt:at,revokedBy:actor,reason:'Cadastro de origem inativo, ausente ou bloqueado.'});changes.push({kind:'visitors',id:visit.id,before,after:structuredClone(visit)});
 }
 const checked=validateState(next);checked.audit=state.audit;
 return {state:checked,changes,created,updated,missing};
}

export async function importDirectory(db:PostgresDatabase,bucket:ObjectStore,reader:IdSecureReader,progress:(counts:Row)=>void=()=>{}){
 const people:ImportedPerson[]=[],seen=new Set<string>();let total:number|undefined;
 for(let start=0;;){
  const page=await reader.readPage(start,50);
  if(total!==undefined&&page.total!==total)throw Error('O diretório mudou durante a leitura. Execute novamente.');total=page.total;
  for(const person of page.items){if(seen.has(person.nativeId))throw Error('Paginação inconsistente. Execute novamente.');seen.add(person.nativeId);people.push(person);}
  start+=page.items.length;if(start===total)break;if(!page.items.length||start>total)throw Error('Paginação incompleta.');
 }
 let photos=0,photoErrors=0,processed=0;
 // Bounded workers; credentials, raw user detail and face templates are never persisted.
 let cursor=0;
 const worker=async()=>{while(cursor<people.length){const person=people[cursor++];try{
  const photo=await reader.readPhoto(person);
  if(photo){const objectKey='directory-photos/'+reader.sourceId+'/'+photo.sha256;await bucket.put(objectKey,photo.bytes);person.photo={objectKey,size:photo.bytes.length,sha256:photo.sha256,contentType:photo.contentType};photos++;}else person.photo=null;
 }catch(error){if((error as {kind?:string}).kind==='authentication')throw error;photoErrors++;}
 processed++;if(processed%50===0||processed===people.length)progress({processed,total,photos,photoErrors});}};
 await Promise.all([worker(),worker()]);
 return db.transaction(async(client,connection)=>{
  const meta=await client.query('SELECT revision FROM operational_meta WHERE id=1 FOR UPDATE');if(meta.rows.length!==1)throw Error('Base não inicializada.');
  const revision=Number(meta.rows[0].revision),state=createInitialState() as Row;
  for(const row of (await client.query('SELECT collection,body FROM operational_records')).rows)if(COLLECTIONS.includes(row.collection))state[row.collection].push(JSON.parse(row.body));
  for(const row of (await client.query('SELECT id,body FROM operational_settings')).rows)if(['settings','berths'].includes(row.id))state[row.id]=JSON.parse(row.body);
  const at=new Date().toISOString(),merged=mergeDirectory(state,reader.sourceId,people,at);
  if(merged.changes.length){
   for(const change of merged.changes)await connection.prepare('INSERT INTO operational_records(collection,id,body) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body').bind(change.kind,change.id,JSON.stringify(change.after)).run();
   const event={id:'audit_'+randomUUID(),at,actor,actorId:null,role:'integration',action:'DIRECTORY_IMPORT',entity:'people',entityId:reader.sourceId,detail:'Importação do diretório; nenhuma autorização física concedida.',reason:null,changes:merged.changes};
   await client.query('INSERT INTO operational_audit(id,at,body) VALUES($1,$2,$3)',[event.id,at,JSON.stringify(event)]);
   merged.state.audit=[event];
   await client.query('UPDATE operational_meta SET revision=revision+1 WHERE id=1');
   await client.query('INSERT INTO operational_changes(revision,created_at,body) VALUES($1,$2,$3)',[revision+1,at,JSON.stringify(stateDelta(state,merged.state))]);
   await client.query('DELETE FROM operational_changes WHERE revision<$1',[Math.max(0,revision-1000)]);
   for(const person of merged.state.people)if(person.directory?.sourceId===reader.sourceId&&(person.directory.inactive||person.directory.blocked||person.directory.missing))await client.query("DELETE FROM operational_passes WHERE visitor_id IN (SELECT id FROM operational_records WHERE collection='visitors' AND body::jsonb->>'personId'=$1)",[person.id]);
  }
  return {total,created:merged.created,updated:merged.updated,missing:merged.missing,photos,photoErrors,changed:merged.changes.length>0};
 });
}
