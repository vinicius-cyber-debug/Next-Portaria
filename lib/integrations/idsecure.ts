import {request as httpsRequest} from 'node:https';
import {X509Certificate,createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {readFile} from 'node:fs/promises';
import {IntegrationError} from './contracts.ts';

export type IdSecureConfig={origin:string;username:string;password:string;fingerprint256:string;certificatePath:string;mode:'read_only';sourceId:string};
export type DirectoryPerson={recordId:string;nativeId:string;name:string;registration:string;documentLast4:string;inactive:boolean;blocked:boolean;visitor:boolean};
export type DirectoryPhoto={bytes:Buffer;contentType:'image/jpeg'|'image/png'|'image/webp';sha256:string};
type ExternalRow=Record<string,unknown>;
const MAX_RESPONSE=6*1024*1024;
/** Preserve 64-bit identifiers instead of rounding them through IEEE754. Strings are skipped intact. */
export function parseDirectoryJson(text:string):unknown{
 return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,(whole,number:string|undefined)=>number&&/^-?\d+$/.test(number)&&!Number.isSafeInteger(Number(number))?JSON.stringify(number):whole));
}
function nativeId(value:unknown){const text=String(value??'');if(!/^\d{1,20}$/.test(text)||BigInt(text)<BigInt(1)||(typeof value==='number'&&!Number.isSafeInteger(value)))throw new IntegrationError('invalid_input');return BigInt(text).toString()}
function flag(value:unknown){if(value==='Sim')return true;if(value==='Não')return false;if(value===true||value===1||value==='1'||value==='true')return true;if(value===false||value===0||value==='0'||value==='false'||value==null)return false;throw new IntegrationError('invalid_input')}
export function directoryPerson(row:ExternalRow,{list=false}={}):DirectoryPerson{
 if(typeof row.name!=='string'||!row.name.trim()||row.name.length>150||row.inativo==null||row.blackList==null||row.idType==null||!Number.isSafeInteger(Number(row.idType)))throw new IntegrationError('invalid_input');
 const registration=typeof row.registration==='string'?row.registration.trim().slice(0,80):'',document=String(row.cpf??'').replace(/\D/g,'');
 return {recordId:nativeId(row.id),nativeId:nativeId(row.idDevice),name:row.name.trim(),registration:/^\d{11,14}$/.test(registration)?'':registration,documentLast4:document.length===11?document.slice(-4):'',inactive:(list&&['Sim','Não'].includes(String(row.inativo))?!flag(row.inativo):flag(row.inativo))||flag(row.deleted),blocked:flag(row.blackList),visitor:Number(row.idType??0)!==0};
}
export function directoryPhoto(value:unknown):DirectoryPhoto|null{
 if(value==null||value==='')return null;if(typeof value!=='string'||value.length>MAX_RESPONSE)throw new IntegrationError('invalid_input');
 const encoded=value.replace(/^data:image\/(?:jpeg|png|webp);base64,/,''),bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>4*1024*1024||bytes.toString('base64').replace(/=+$/,'')!==encoded.replace(/\s|=+$/g,''))throw new IntegrationError('invalid_input');
 const contentType=bytes.subarray(0,3).equals(Buffer.from([255,216,255]))?'image/jpeg':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
 if(!contentType)throw new IntegrationError('invalid_input');return {bytes,contentType,sha256:createHash('sha256').update(bytes).digest('hex')};
}
/** Central iDSecure directory, not a turnstile driver. No device writes or biometric-template methods. */
export class IdSecureReader {
 readonly mode='read_only';#config:IdSecureConfig;#ca:string;#token:string|null=null;
 constructor(config:IdSecureConfig,ca:string){
  const url=new URL(config.origin),parts=url.hostname.split('.').map(Number),privateHost=isIP(url.hostname)===4&&(parts[0]===127||parts[0]===10||parts[0]===192&&parts[1]===168||parts[0]===172&&parts[1]>=16&&parts[1]<=31);
  if(config.mode!=='read_only'||url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!privateHost||!config.username||!config.password||!/^([\da-f]{2}:){31}[\da-f]{2}$/i.test(config.fingerprint256)||!/^[a-z0-9_-]{2,60}$/.test(config.sourceId))throw new IntegrationError('invalid_input');
  const certificate=new X509Certificate(ca);if(certificate.fingerprint256.toUpperCase()!==config.fingerprint256.toUpperCase()||Date.parse(certificate.validFrom)>Date.now()||Date.parse(certificate.validTo)<=Date.now())throw new IntegrationError('invalid_input');
  this.#config={...config,origin:url.origin};this.#ca=ca;
 }
 get sourceId(){return this.#config.sourceId}
 static async fromFile(path:string){const config=JSON.parse(await readFile(path,'utf8')) as IdSecureConfig;return new IdSecureReader(config,await readFile(config.certificatePath,'utf8'))}
 private async call(path:string,method:'GET'|'POST',body:unknown,authenticated=true):Promise<unknown>{
  if(!((method==='POST'&&(path==='/api/login/'||path.startsWith('/api/user/list?')))||(method==='GET'&&(/^\/api\/user\/\d+$/.test(path)||path.startsWith('/api/access/monitor?')||path==='/api/device/'))))throw new IntegrationError('unsupported');
  if(authenticated&&!this.#token)await this.login();const encoded=body===undefined?undefined:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
   const request=httpsRequest(this.#config.origin+path,{method,ca:this.#ca,allowPartialTrustChain:true,checkServerIdentity:(_host,certificate)=>certificate.fingerprint256.toUpperCase()===this.#config.fingerprint256.toUpperCase()?undefined:Error('Certificate mismatch'),timeout:10000,headers:{accept:'application/json',...(encoded!==undefined?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{}),...(authenticated?{authorization:'Bearer '+this.#token}:{})}},response=>{
    let size=0;const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_RESPONSE){request.destroy();reject(new IntegrationError('invalid_input'));return}chunks.push(chunk)});response.on('end',()=>{
     if(response.statusCode===401||response.statusCode===403){this.#token=null;reject(new IntegrationError('authentication'));return}
     if(response.statusCode!==200){reject(new IntegrationError(response.statusCode===404?'unsupported':'offline'));return}
     try{resolve(parseDirectoryJson(Buffer.concat(chunks).toString('utf8')))}catch{reject(new IntegrationError('invalid_input'))}
    });response.on('error',()=>reject(new IntegrationError('offline')));
   });request.on('timeout',()=>request.destroy(new IntegrationError('timeout')));request.on('error',error=>reject(error instanceof IntegrationError?error:new IntegrationError('offline')));request.end(encoded);
  });
 }
 private async login(){const response=await this.call('/api/login/','POST',{username:this.#config.username,password:this.#config.password},false) as ExternalRow;if(typeof response?.accessToken!=='string'||response.accessToken.length>16000)throw new IntegrationError('authentication');this.#token=response.accessToken}
 async readPage(offset=0,limit=50){
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new IntegrationError('invalid_input');
  const query=new URLSearchParams({idType:'0',deleted:'false',draw:'1',start:String(offset),length:String(limit),'columns[0][data]':'idDevice','columns[0][name]':'idDevice','order[0][column]':'0','order[0][dir]':'asc'});
  const result=await this.call('/api/user/list?'+query,'POST',null) as ExternalRow;
  if(!Array.isArray(result?.data)||result.data.length>limit||!Number.isSafeInteger(Number(result.recordsFiltered))||Number(result.recordsFiltered)<0||Number(result.recordsFiltered)>100000||result.error)throw new IntegrationError('invalid_input');
  return {items:result.data.map(row=>directoryPerson(row as ExternalRow,{list:true})),total:Number(result.recordsFiltered)};
 }
 async readPhoto(person:DirectoryPerson){
  const record=await this.call('/api/user/'+nativeId(person.recordId),'GET',undefined) as ExternalRow;
  if(nativeId(record.idDevice)!==person.nativeId||nativeId(record.id)!==person.recordId)throw new IntegrationError('invalid_input');
  const fresh=directoryPerson(record);person.inactive=fresh.inactive;person.blocked=fresh.blocked;person.visitor=fresh.visitor;return directoryPhoto(record.foto);
 }
 async readDevices(){
  const response=await this.call('/api/device/','GET',undefined) as ExternalRow,rows=Array.isArray(response)?response:response.data;
  if(!Array.isArray(rows)||rows.length>500)throw new IntegrationError('invalid_input');
  return rows.map((row:ExternalRow)=>({id:nativeId(row.id),name:String(row.name??'').slice(0,150),model:Number(row.model),firmware:String(row.versao??'').slice(0,60),faceReaders:Number(row.idfaceCount??0),online:row.isCurrentlyOnline===true}));
 }
 async readMonitor(){
  // The central returns its configured window (currently 15), regardless of limite.
  const query=new URLSearchParams({mode:'logs',modevalue:'',areas:'',limite:'50',events:'',parkings:''});
  const result=await this.call('/api/access/monitor?'+query,'GET',undefined) as ExternalRow;
  if(!Array.isArray(result?.data)||result.data.length>500||result.error)throw new IntegrationError('invalid_input');
  return result.data as ExternalRow[];
 }
}
