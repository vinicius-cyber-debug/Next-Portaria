'use client';
/* eslint-disable @next/next/no-img-element -- Images require the session cookie and must bypass shared optimization caches. */
import {useCallback,useEffect,useRef,useState} from 'react';
import {request} from '../lib/http-client';
type Asset={id:string;name:string;type:string;size:number;expiresAt:string|null};
type Upload={id:string;name:string;size:number;expiresAt:string};
type Session={id:string;assetId:string;status?:string;size?:number;type?:string;recordId?:string;chunkSize:number;expiresAt:string;parts:{index:number;sha256:string}[]};
type Props={recordId:string;userId:string;canUpload:boolean;isAdmin:boolean;changed:()=>Promise<void>};
async function api<T=unknown>(path:string,init?:RequestInit):Promise<T>{const response=await request('/api/media/'+path,init),data=await response.json() as T&{error?:{message?:string}};if(!response.ok)throw Error(data.error?.message??'Falha ao acessar arquivos.');return data;}
const send=(data:unknown)=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const sha=async(bytes:ArrayBuffer)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
export default function IncidentMedia({recordId,userId,canUpload,isAdmin,changed}:Props){
 const [assets,setAssets]=useState<Asset[]>([]),[pending,setPending]=useState<Upload[]>([]),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0),[error,setError]=useState(''),[message,setMessage]=useState(''),[available,setAvailable]=useState<boolean|null>(null),[retention,setRetention]=useState(''),[policyOpen,setPolicyOpen]=useState(false);
 const abort=useRef<AbortController|null>(null),key=`portaria-upload:${userId}:${recordId}`;
 const load=useCallback(async()=>{
  try{const [list,policy,uploads]=await Promise.all([api<{assets:Asset[]}>('records?id='+encodeURIComponent(recordId)),api<{retentionDays:number|null}>('policy'),canUpload?api<{uploads:Upload[]}>('uploads?recordId='+encodeURIComponent(recordId)):Promise.resolve({uploads:[]})]);setAssets(list.assets);setPending(uploads.uploads);setRetention(policy.retentionDays===null?'':String(policy.retentionDays));setAvailable(true);}catch(e){setAvailable(false);setError(e instanceof Error?e.message:'Arquivos indisponíveis.');}
 },[recordId,canUpload]);
 useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>{clearTimeout(timer);abort.current?.abort();};},[load]);
 async function upload(){
  if(!file||busy)return;setError('');setMessage('');setBusy(true);setProgress(0);const controller=new AbortController();abort.current=controller;
  try{
   if(!['video/mp4','video/webm','image/png','image/jpeg','image/webp'].includes(file.type)||file.size<1||file.size>(file.type.startsWith('video/')?256:10)*1024*1024)throw Error('Use MP4/WebM até 256 MiB ou imagens PNG/JPEG/WebP até 10 MiB.');
   const fingerprint=JSON.stringify([file.name,file.size,file.type,file.lastModified]);let saved:null|{fingerprint:string;id:string}=null;
   try{saved=JSON.parse(localStorage.getItem(key)??'null');}catch{/* optional local resume cache */}
   let session:Session|null=null;
   if(saved?.fingerprint===fingerprint){session=await api<Session>('uploads/'+saved.id);if(session.status==='completed'){localStorage.removeItem(key);setMessage('Este arquivo já foi enviado.');await load();return;}if(session.status!=='uploading'||new Date(session.expiresAt).getTime()<=Date.now())session=null;}
   if(!session){session=await api<Session>('uploads',send({recordId,name:file.name,type:file.type,size:file.size}));try{localStorage.setItem(key,JSON.stringify({id:session.id,fingerprint}));}catch{/* Server still tracks pending uploads. */}session={...session,parts:[]};}
   if(session.size!==undefined&&(session.size!==file.size||session.type!==file.type||session.recordId!==recordId))throw Error('O arquivo selecionado não corresponde ao envio pendente.');
   const existing=new Map<number,{sha256:string}>(session.parts.map((p:{index:number;sha256:string})=>[p.index,p]));
   for(let index=0;index<Math.ceil(file.size/session.chunkSize);index++){
    if(controller.signal.aborted)throw new DOMException('Pausado','AbortError');
    const bytes=await file.slice(index*session.chunkSize,Math.min(file.size,(index+1)*session.chunkSize)).arrayBuffer(),hash=await sha(bytes),part=existing.get(index);
    if(part&&part.sha256!==hash)throw Error('O conteúdo mudou. Cancele o envio pendente e selecione o arquivo correto.');
    if(!part)await api(`uploads/${session.id}/parts/${index}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Content-SHA256':hash},body:bytes,signal:controller.signal});
    setProgress(Math.round(Math.min(file.size,(index+1)*session.chunkSize)/file.size*100));
   }
   await api('uploads/'+session.id+'/complete',{method:'POST',signal:controller.signal});try{localStorage.removeItem(key);}catch{/* cache unavailable */}
   setFile(null);setMessage('Arquivo enviado e conferido.');await load();await changed();
  }catch(e){if(e instanceof Error&&e.name==='AbortError')setMessage('Envio pausado. Selecione o mesmo arquivo e clique em Enviar ou retomar.');else setError(e instanceof Error?e.message:'Envio interrompido. Selecione o mesmo arquivo para retomar.');await load();}
  finally{setBusy(false);abort.current=null;}
 }
 if(available===null)return <p className="field-hint">Consultando fotos e vídeos…</p>;
 if(!available)return <p className="field-hint">Fotos e vídeos com retomada estão disponíveis na instalação PostgreSQL.</p>;
 return <section className="v3-spaced" aria-label="Fotos e vídeos da ocorrência">
  <h3>Fotos e vídeos</h3><p className="field-hint">Acesso privado. MP4 e WebM até 256 MiB; imagens até 10 MiB. Até 20 arquivos por ocorrência. A reprodução depende do codec aceito pelo aparelho.</p>
  {assets.map(asset=><figure key={asset.id} className="v3-spaced">
   {asset.type.startsWith('video/')?<video controls playsInline preload="metadata" style={{width:'100%',maxHeight:360}} src={'/api/media/'+asset.id+'/content'} onError={()=>setError('Não foi possível reproduzir este vídeo. Verifique o codec ou tente outro navegador.')}/>:<a href={'/api/media/'+asset.id+'/content'} target="_blank" rel="noreferrer"><img alt={asset.name} loading="lazy" style={{maxWidth:'100%',maxHeight:300}} src={'/api/media/'+asset.id+'/content'}/></a>}
   <figcaption>{asset.name} · {(asset.size/1024/1024).toFixed(1)} MiB{asset.expiresAt?' · Retenção até '+new Date(asset.expiresAt).toLocaleDateString('pt-BR'):''}</figcaption>
  </figure>)}
  {canUpload&&<div className="v3-spaced"><label className="form-field"><span className="field-label">Adicionar foto ou vídeo</span><input type="file" accept="video/mp4,video/webm,image/png,image/jpeg,image/webp" disabled={busy} onChange={e=>{setFile(e.target.files?.[0]??null);setMessage('');setError('');}}/></label>
   <p className="field-hint">Para retomar após fechar a página, selecione o mesmo arquivo neste navegador. Envios incompletos vencem em 24 horas.</p>
   <div className="actions"><button type="button" className="button primary" disabled={!file||busy} onClick={()=>void upload()}>Enviar ou retomar</button>{busy&&<button type="button" className="button secondary" onClick={()=>abort.current?.abort()}>Pausar</button>}</div>
   {busy&&<label>Envio: {progress}% <progress value={progress} max={100}/></label>}
   {pending.map(item=><p key={item.id}>{item.name} · envio pendente <button type="button" className="button secondary" disabled={busy} onClick={async()=>{try{await api('uploads/'+item.id,{method:'DELETE'});try{const cached=JSON.parse(localStorage.getItem(key)??'null');if(cached?.id===item.id)localStorage.removeItem(key);}catch{/* cache optional */}await load();}catch(e){setError((e as Error).message);}}}>Cancelar envio</button></p>)}
  </div>}
  {isAdmin&&<details open={policyOpen} onToggle={e=>setPolicyOpen(e.currentTarget.open)} className="v3-spaced"><summary>Retenção de fotos e vídeos da unidade</summary><p>A política vale para todos os arquivos deste módulo, incluindo os já enviados. Ao vencer, o arquivo deixa de ser acessível e será removido pela rotina diária. Backups seguem a política própria da empresa.</p><label>Dias de retenção (vazio conserva os arquivos)<input className="input" type="number" min="1" max="3650" value={retention} onChange={e=>setRetention(e.target.value)}/></label><button type="button" className="button secondary" disabled={busy} onClick={async()=>{if(!window.confirm('Aplicar esta retenção a todos os arquivos, incluindo os existentes? Arquivos já vencidos ficarão indisponíveis.'))return;try{await api('policy',send({retentionDays:retention===''?null:Number(retention),confirmExisting:true}));await api('retention/run',{method:'POST'});await load();await changed();setMessage('Política de retenção aplicada.');}catch(e){setError((e as Error).message);}}}>Aplicar política</button></details>}
  {error&&<p role="alert" className="notice error">{error}</p>}{message&&<p role="status" className="notice success">{message}</p>}
 </section>;
}
