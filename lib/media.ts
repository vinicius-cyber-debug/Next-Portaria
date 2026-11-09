import {randomUUID} from 'node:crypto';
import {statfs} from 'node:fs/promises';
import type {PoolClient} from 'pg';
import type {PostgresDatabase} from './persistence/postgres.ts';
import type {FileObjectStore} from './storage/filesystem.ts';
import type {MediaContext,MediaUser} from './persistence/contracts.ts';
import {canWithCapabilities} from './access.mjs';
import {PostgresError} from './persistence/postgres-errors.ts';

export const MEDIA_LIMITS={video:256*1024*1024,image:10*1024*1024,chunk:5*1024*1024,perRecord:20,pendingPerUser:3,total:20*1024*1024*1024};
const types=new Set(['video/mp4','video/webm','image/png','image/jpeg','image/webp']);
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','Vary':'Cookie','X-Content-Type-Options':'nosniff'};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
class MediaError extends Error{status:number;constructor(message:string,status=400){super(message);this.status=status;}}
const fail=(message:string,status=400):never=>{throw new MediaError(message,status);};
function permission(user:MediaUser,write=false){if(user.status!=='active'||!user.capabilities?.documentView||(write&&!canWithCapabilities(user,'INCIDENT_CREATE')))fail('Seu acesso não permite esta operação com arquivos.',403);}
function admin(user:MediaUser){if(user.status!=='active'||user.role!=='admin')fail('Somente administradores podem configurar a retenção.',403);}
async function body(request:Request){
 if(!request.headers.get('content-type')?.startsWith('application/json')||!request.body)fail('Envie dados JSON.',415);
 const reader=request.body!.getReader();let size=0,text='';const decoder=new TextDecoder();
 while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8192){await reader.cancel();fail('Solicitação muito grande.',413);}text+=decoder.decode(part.value,{stream:true});}
 try{const value=JSON.parse(text+decoder.decode());if(value&&typeof value==='object'&&!Array.isArray(value))return value as Record<string,unknown>;}catch{/* invalid JSON */}return fail('Dados inválidos.');
}
function signature(type:string,bytes:Buffer){
 if(type==='video/mp4')return bytes.length>=16&&bytes.toString('ascii',4,8)==='ftyp';
 if(type==='video/webm')return bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))&&bytes.includes(Buffer.from('webm'));
 if(type==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(type==='image/jpeg')return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 return type==='image/webp'&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
}
export function byteRange(value:string|null,size:number){
 if(!value)return null;const match=/^bytes=(\d*)-(\d*)$/.exec(value);
 if(!match||(!match[1]&&!match[2]))return false;
 const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));let end=match[1]?(match[2]?Number(match[2]):size-1):size-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start||(!match[1]&&Number(match[2])===0))return false;
 end=Math.min(end,size-1);return {start,end};
}
export class MediaService {
 readonly db:PostgresDatabase;readonly store:FileObjectStore;
 constructor(db:PostgresDatabase,store:FileObjectStore){this.db=db;this.store=store;}
 private async transaction<T>(context:MediaContext,check:(user:MediaUser)=>void,operation:(client:PoolClient,user:MediaUser)=>Promise<T>){
  return this.db.transaction(async(client,scoped)=>{await client.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');const user=await context.authorize(scoped);check(user);return operation(client,user);});
 }
 private async audit(client:PoolClient,user:MediaUser,action:string,id:string,detail:unknown){
  const event={id:'audit_'+randomUUID(),at:new Date().toISOString(),actor:user.name,actorId:user.id,role:user.role,action,entity:'media',entityId:id,detail:JSON.stringify(detail),changes:[]};
  await client.query('INSERT INTO operational_audit(id,at,body) VALUES($1,$2,$3)',[event.id,event.at,JSON.stringify(event)]);await client.query('UPDATE operational_meta SET revision=revision+1 WHERE id=1');
 }
 private async upload(client:PoolClient,id:string,user:MediaUser,open=false){
  const row=(await client.query('SELECT u.*,a.object_key,a.mime_type,a.original_name FROM media_uploads u JOIN media_assets a ON a.id=u.asset_id WHERE u.id=$1 FOR UPDATE OF u',[id])).rows[0];
  if(!row||row.created_by!==user.id)fail('Envio não encontrado.',404);
  if(open&&(row.status!=='uploading'||new Date(row.expires_at).getTime()<=Date.now()))fail('Este envio encerrou ou venceu. Inicie outro envio.',409);
  return row;
 }
 async handle(request:Request,context:MediaContext):Promise<Response>{
  try{
   const url=new URL(request.url),path=url.pathname.slice('/api/media/'.length),method=request.method;
   permission(context.user);
   if(path==='policy'&&method==='GET')return json({limits:MEDIA_LIMITS,retentionDays:(await this.db.pool.query('SELECT retention_days FROM media_policy WHERE id=1')).rows[0].retention_days});
   if(path==='policy'&&method==='POST'){
    admin(context.user);const data=await body(request),days=data.retentionDays;
    if(days!==null&&(!Number.isInteger(days)||Number(days)<1||Number(days)>3650))fail('Informe de 1 a 3650 dias, ou mantenha sem exclusão automática.');
    if(data.confirmExisting!==true)fail('Confirme a aplicação desta política aos arquivos existentes.');
    await this.transaction(context,admin,async(client,user)=>{await client.query('UPDATE media_policy SET retention_days=$1,updated_at=now() WHERE id=1',[days]);await client.query("UPDATE media_assets SET expires_at=CASE WHEN $1::int IS NULL THEN NULL ELSE created_at+make_interval(days=>$1) END WHERE status='ready'",[days]);await this.audit(client,user,'MEDIA_RETENTION_POLICY','policy',{retentionDays:days});});return json({ok:true});
   }
   if(path==='retention/run'&&method==='POST'){admin(context.user);return json(await this.runRetention(context));}
   if(path==='records'&&method==='GET'){
    const recordId=url.searchParams.get('id');if(!recordId)fail('Selecione uma ocorrência.');
    const rows=(await this.db.pool.query("SELECT a.id,a.original_name AS name,a.mime_type AS type,a.size_bytes AS size,a.created_at AS \"createdAt\",a.expires_at AS \"expiresAt\" FROM media_assets a JOIN media_links l ON l.asset_id=a.id WHERE l.collection='incidents' AND l.record_id=$1 AND a.status='ready' AND (a.expires_at IS NULL OR a.expires_at>now()) ORDER BY a.created_at",[recordId])).rows;
    return json({assets:rows});
   }
   if(path==='uploads'&&method==='POST'){
    permission(context.user,true);const data=await body(request),size=data.size,type=data.type,name=String(data.name??'').replace(/[\\/\x00-\x1f"<>]/g,'_').slice(0,150),record=String(data.recordId??'');
    if(!types.has(String(type))||!name||!Number.isSafeInteger(size)||Number(size)<1||Number(size)>(String(type).startsWith('video/')?MEDIA_LIMITS.video:MEDIA_LIMITS.image))fail('Use MP4/WebM até 256 MiB ou PNG/JPEG/WebP até 10 MiB.');
    const result=await this.transaction(context,u=>permission(u,true),async(client,user)=>{
     if(!(await client.query("SELECT id FROM operational_records WHERE collection='incidents' AND id=$1",[record])).rowCount)fail('Ocorrência não encontrada.',404);
     if(Number((await client.query("SELECT count(*) AS n FROM media_uploads WHERE created_by=$1 AND status IN ('uploading','processing') AND expires_at>now()",[user.id])).rows[0].n)>=MEDIA_LIMITS.pendingPerUser)fail('Conclua ou cancele seus três envios pendentes.',429);
     if(Number((await client.query("SELECT count(*) AS n FROM media_links l JOIN media_assets a ON a.id=l.asset_id WHERE l.collection='incidents' AND l.record_id=$1 AND a.status NOT IN ('deleted','failed')",[record])).rows[0].n)>=MEDIA_LIMITS.perRecord)fail('Limite de 20 arquivos nesta ocorrência.',409);
     const used=Number((await client.query("SELECT COALESCE(sum(size_bytes),0) AS n FROM media_assets WHERE status NOT IN ('deleted','failed')")).rows[0].n);
     if(used+Number(size)>MEDIA_LIMITS.total)fail('A cota de armazenamento de 20 GiB foi atingida.',413);
     const assetId='media_'+randomUUID(),id='upload_'+randomUUID();
     await client.query("INSERT INTO media_assets(id,object_key,original_name,mime_type,size_bytes,status,created_by) VALUES($1,$2,$3,$4,$5,'uploading',$6)",[assetId,'media/'+assetId,name,type,size,user.id]);
     await client.query("INSERT INTO media_links(asset_id,collection,record_id) VALUES($1,'incidents',$2)",[assetId,record]);
     const row=(await client.query("INSERT INTO media_uploads(id,asset_id,created_by,record_id,total_size,chunk_size,status) VALUES($1,$2,$3,$4,$5,$6,'uploading') RETURNING expires_at",[id,assetId,user.id,record,size,MEDIA_LIMITS.chunk])).rows[0];
     await this.audit(client,user,'MEDIA_UPLOAD_START',assetId,{name,size,type,recordId:record});return {id,assetId,chunkSize:MEDIA_LIMITS.chunk,expiresAt:row.expires_at};
    });return json(result,201);
   }
   if(path==='uploads'&&method==='GET'){
    permission(context.user,true);
    return json({uploads:(await this.db.pool.query("SELECT u.id,u.total_size AS size,u.expires_at AS \"expiresAt\",a.original_name AS name FROM media_uploads u JOIN media_assets a ON a.id=u.asset_id WHERE u.created_by=$1 AND u.record_id=$2 AND u.status IN ('uploading','processing') AND u.expires_at>now() ORDER BY u.created_at",[context.user.id,url.searchParams.get('recordId')])).rows});
   }
   const uploadPath=/^uploads\/(upload_[a-f0-9-]+)(?:\/(complete|parts\/\d+))?$/.exec(path);
   if(uploadPath){
    permission(context.user,true);const id=uploadPath[1],action=uploadPath[2];
    if(!action&&method==='GET')return json(await this.transaction(context,u=>permission(u,true),async(client,user)=>{const row=await this.upload(client,id,user);return {id:row.id,assetId:row.asset_id,status:row.status,size:Number(row.total_size),type:row.mime_type,name:row.original_name,recordId:row.record_id,chunkSize:row.chunk_size,expiresAt:row.expires_at,parts:(await client.query('SELECT part_index AS index,size_bytes AS size,sha256 FROM media_upload_parts WHERE upload_id=$1 ORDER BY part_index',[id])).rows};}));
    if(!action&&method==='DELETE'){
     await this.transaction(context,u=>permission(u,true),async(client,user)=>{const row=await this.upload(client,id,user);if(row.status==='completed')fail('O envio já foi concluído.',409);await client.query("UPDATE media_uploads SET status='aborted',lease=NULL,lease_until=NULL WHERE id=$1",[id]);await client.query("UPDATE media_assets SET status='deleted',deleted_at=now() WHERE id=$1",[row.asset_id]);await this.audit(client,user,'MEDIA_UPLOAD_ABORT',row.asset_id,{});});return json({ok:true});
    }
    if(action?.startsWith('parts/')&&method==='PUT'){
     const index=Number(action.slice(6)),hash=request.headers.get('x-content-sha256');if(!/^[a-f0-9]{64}$/.test(hash??'')||!request.body)fail('Informe o conteúdo e SHA-256 da parte.');
     const row=await this.transaction(context,u=>permission(u,true),(client,user)=>this.upload(client,id,user,true));
     if(!Number.isSafeInteger(index)||index<0||index>=Math.ceil(Number(row.total_size)/row.chunk_size))fail('Parte inválida.');
     const expected=Math.min(row.chunk_size,Number(row.total_size)-index*row.chunk_size),disk=await statfs(this.store.root);
     if(Number(disk.bavail)*Number(disk.bsize)<expected+1024*1024*1024)fail('Espaço livre insuficiente; preserve ao menos 1 GiB no disco.',507);
     const key=`uploads/${id}/${index}-${randomUUID()}`;let written=false,commitAttempted=false;
     try{
      const result=await this.store.putStream(key,request.body!,expected);written=true;if(result.size!==expected||result.sha256!==hash)fail('Tamanho ou SHA-256 da parte não confere.',422);
      const saved=await this.transaction(context,u=>permission(u,true),async(client,user)=>{
       await this.upload(client,id,user,true);const previous=(await client.query('SELECT sha256,size_bytes FROM media_upload_parts WHERE upload_id=$1 AND part_index=$2',[id,index])).rows[0];
       if(previous){if(previous.sha256!==hash||Number(previous.size_bytes)!==expected)fail('Esta parte já existe com outro conteúdo.',409);return false;}
       await client.query('INSERT INTO media_upload_parts(upload_id,part_index,size_bytes,sha256,object_key) VALUES($1,$2,$3,$4,$5)',[id,index,result.size,result.sha256,key]);commitAttempted=true;return true;
      });
      if(!saved)await this.store.delete(key);return json({index,sha256:hash,size:expected});
     }catch(error){if(written&&!commitAttempted)await this.store.delete(key);throw error;}
    }
    if(action==='complete'&&method==='POST'){
     const lease=randomUUID();
     const claim=await this.transaction(context,u=>permission(u,true),async(client,user)=>{
      const row=await this.upload(client,id,user);if(row.status==='completed')return {row,parts:null};
      if(new Date(row.expires_at).getTime()<=Date.now()||!['uploading','processing'].includes(row.status))fail('Envio vencido ou encerrado.',409);
      if(row.status==='processing'&&new Date(row.lease_until).getTime()>Date.now())fail('A conclusão já está em andamento. Tente novamente em instantes.',409);
      const parts=(await client.query('SELECT * FROM media_upload_parts WHERE upload_id=$1 ORDER BY part_index',[id])).rows;
      if(parts.length!==Math.ceil(Number(row.total_size)/row.chunk_size)||parts.some((p,i)=>p.part_index!==i)||parts.reduce((n,p)=>n+Number(p.size_bytes),0)!==Number(row.total_size))fail('Envie todas as partes antes de concluir.',409);
      await client.query("UPDATE media_uploads SET status='processing',lease=$2,lease_until=now()+interval '15 minutes' WHERE id=$1",[id,lease]);return {row,parts};
     });
     const {row,parts}=claim;if(!parts)return json({assetId:row.asset_id,replayed:true});
     try{
      const result=await this.store.compose(row.object_key,parts,Number(row.total_size));
      if(result.size!==Number(row.total_size)||!signature(row.mime_type,await this.store.prefix(row.object_key)))fail('O conteúdo não corresponde a uma imagem ou vídeo permitido.',422);
      await this.transaction(context,u=>permission(u,true),async(client,user)=>{
       const fresh=await this.upload(client,id,user);if(fresh.lease!==lease||fresh.status!=='processing')fail('A conclusão foi cancelada ou substituída.',409);
       await client.query("UPDATE media_assets SET status='ready',sha256=$2,size_bytes=$3,updated_at=now(),expires_at=(SELECT CASE WHEN retention_days IS NULL THEN NULL ELSE now()+make_interval(days=>retention_days) END FROM media_policy WHERE id=1) WHERE id=$1",[row.asset_id,result.sha256,result.size]);
       await client.query("UPDATE media_uploads SET status='completed',lease=NULL,lease_until=NULL WHERE id=$1",[id]);await this.audit(client,user,'MEDIA_UPLOAD_COMPLETE',row.asset_id,{sha256:result.sha256,size:result.size});
      });return json({assetId:row.asset_id,sha256:result.sha256,size:result.size});
     }catch(error){await this.db.pool.query("UPDATE media_uploads SET status='uploading',lease=NULL,lease_until=NULL WHERE id=$1 AND status='processing' AND lease=$2",[id,lease]);throw error;}
    }
   }
   const content=/^(media_[a-f0-9-]+)\/content$/.exec(path);
   if(content&&['GET','HEAD'].includes(method)){
    const asset=(await this.db.pool.query("SELECT a.* FROM media_assets a JOIN media_links l ON l.asset_id=a.id JOIN operational_records r ON r.collection=l.collection AND r.id=l.record_id WHERE a.id=$1 AND a.status='ready' AND (a.expires_at IS NULL OR a.expires_at>now())",[content[1]])).rows[0];
    if(!asset)fail('Arquivo não encontrado ou retenção vencida.',404);
    const size=Number(asset.size_bytes),info=await this.store.head(asset.object_key);if(info?.size!==size)fail('Arquivo indisponível; procure o administrador.',503);
    const range=byteRange(request.headers.get('range'),size),out={'Cache-Control':'no-store, private','Vary':'Cookie','X-Content-Type-Options':'nosniff','Content-Type':asset.mime_type,'Accept-Ranges':'bytes','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(asset.original_name)}`};
    if(range===false)return new Response(null,{status:416,headers:{...out,'Content-Range':`bytes */${size}`}});
    const start=range?.start??0,end=range?.end??size-1;
    return new Response(method==='HEAD'?null:await this.store.range(asset.object_key,start,end),{status:range?206:200,headers:{...out,'Content-Length':String(end-start+1),...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})}});
   }
   return json({error:{message:'Operação de mídia não encontrada.'}},404);
  }catch(error){
   if(error instanceof MediaError)return json({error:{code:'MEDIA_ERROR',message:error.message}},error.status);
   if(error instanceof PostgresError)throw error;
   if((error as {code?:string}).code==='BODY_TOO_LARGE')return json({error:{message:'Parte excede o tamanho permitido.'}},413);
   // The outer API owns authentication errors from revalidation.
   const authError=error as {code?:string;status?:number};if(typeof authError.code==='string'&&[401,403].includes(authError.status??0))throw error;
   console.error('Media failure:',(error as Error).message);return json({error:{message:'Não foi possível concluir a operação de mídia.'}},500);
  }
 }
 async runRetention(context:MediaContext){
  const marked=await this.transaction(context,admin,async(client,user)=>{
   const expired=(await client.query("UPDATE media_assets SET status='deleted',deleted_at=now() WHERE status='ready' AND expires_at<=now() RETURNING id")).rows;
   const uploads=(await client.query("UPDATE media_uploads SET status='aborted',lease=NULL,lease_until=NULL WHERE status IN ('uploading','processing') AND expires_at<=now() RETURNING asset_id")).rows;
   if(uploads.length)await client.query("UPDATE media_assets SET status='deleted',deleted_at=now() WHERE id=ANY($1::text[]) AND status<>'ready'",[uploads.map(u=>u.asset_id)]);
   if(expired.length||uploads.length)await this.audit(client,user,'MEDIA_RETENTION_RUN','retention',{assets:expired.length,uploads:uploads.length});return expired.length;
  });
  let purged=0;
  for(const asset of (await this.db.pool.query("SELECT id,object_key FROM media_assets WHERE status='deleted' AND purged_at IS NULL")).rows){await this.store.delete(asset.object_key);await this.db.pool.query("UPDATE media_assets SET purged_at=now() WHERE id=$1 AND status='deleted'",[asset.id]);purged++;}
  for(const part of (await this.db.pool.query("SELECT p.* FROM media_upload_parts p JOIN media_uploads u ON u.id=p.upload_id WHERE u.status IN ('completed','aborted','failed')")).rows){await this.store.delete(part.object_key);await this.db.pool.query('DELETE FROM media_upload_parts WHERE upload_id=$1 AND part_index=$2',[part.upload_id,part.part_index]);}
  return {marked,purged};
 }
}
