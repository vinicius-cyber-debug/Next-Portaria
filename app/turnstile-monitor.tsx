"use client";
import {useEffect,useState} from 'react';
import {Activity,Clock3,RefreshCw,Users,Wifi,WifiOff} from 'lucide-react';
import {request} from '../lib/http-client';
import {Button} from './ui';
type Event={id:string;device:string;area:string;name:string;occurredAt:string;eventName:string;kind:string;personId:string|null;photoUrl:string|null};
type Snapshot={source:string;mode?:'simulation';status:string;lastSuccessAt:string|null;events:Event[]};
const statusNames:Record<string,string>={connected:'iDSecure conectado',offline:'Conexão indisponível',authentication:'Credencial da integração recusada',invalid:'Resposta da central inválida',unconfigured:'Monitor não configurado'};
const date=(value:string,tz:string)=>new Intl.DateTimeFormat('pt-BR',{timeZone:tz,dateStyle:'short',timeStyle:'medium'}).format(new Date(value));
function Photo({event,large=false}:{event:Event;large?:boolean}){
 // Authenticated photos must bypass the public image optimizer and any third-party host.
 // eslint-disable-next-line @next/next/no-img-element
 return event.photoUrl?<img className={large?'turnstile-photo':'turnstile-avatar'} src={event.photoUrl} alt={'Foto de '+event.name} loading="lazy"/>:<span className={large?'turnstile-photo placeholder':'turnstile-avatar placeholder'} aria-hidden="true"><Users size={large?42:22}/></span>;
}
export function TurnstileMonitor({enabled,tz}:{enabled:boolean;tz:string}){
 const [data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(''),[expanded,setExpanded]=useState(false);
 useEffect(()=>{
  if(!enabled)return;
  let disposed=false,loading=false,timer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|undefined;
  const schedule=()=>{if(!disposed)timer=setTimeout(()=>void refresh(),3000);};
  async function refresh(){
   if(disposed||loading)return;if(document.hidden){schedule();return;}loading=true;controller=new AbortController();
   const active=controller,timeout=setTimeout(()=>active.abort(),15000);
   let stop=false;
   try{
    const response=await request('/api/integrations/idsecure/monitor',{cache:'no-store',signal:controller.signal});
    if(response.status===401||response.status===403){if(!disposed){setData(null);setError('Sua sessão ou permissão de consulta mudou. Atualize a página.');}stop=true;return;}
    if(!response.ok)throw Error('Consulta indisponível');
    const snapshot=await response.json() as Snapshot;
    if(!Array.isArray(snapshot.events)||snapshot.events.length>50)throw Error('Resposta inválida');
    if(!disposed){setData(snapshot);setError('');}
   }catch{if(!disposed)setError('Não foi possível consultar a central. Os últimos eventos continuam identificados pelo horário de recebimento.');}
   finally{clearTimeout(timeout);loading=false;if(!stop)schedule();}
  }
  const visible=()=>{if(!document.hidden&&!loading){clearTimeout(timer);void refresh();}};
  document.addEventListener('visibilitychange',visible);void refresh();
  return ()=>{disposed=true;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visible);};
 },[enabled]);
 if(!enabled)return null;
 const connected=data?.status==='connected'&&!error,latest=data?.events[0],events=expanded?data?.events:data?.events.slice(0,4);
 return <section className={'card turnstile-monitor '+(expanded?'expanded':'')} aria-labelledby="turnstile-monitor-title">
  <div className="card-header"><div><h2 className="card-title" id="turnstile-monitor-title"><Activity size={19}/>Movimentação das catracas</h2><p className="card-subtitle">{data?.mode==='simulation'?'Eventos fictícios para apresentação':'Eventos informados pelo iDSecure'} · atualização automática a cada 3 segundos</p></div><span className={'turnstile-connection '+(connected?'connected':'unavailable')} role="status">{connected?<Wifi size={15}/>:<WifiOff size={15}/>} {error?'Consulta indisponível':data?data.mode==='simulation'?'Simulação · dados fictícios':statusNames[data.status]||'Consulta indisponível':'Consultando central…'}</span></div>
  <div className="turnstile-notice"><Clock3 size={16}/><span>Acesso autorizado registra uma liberação. Giro e sentido físico ainda não validados; a presença da portaria permanece separada.</span></div>
  {error&&<p className="turnstile-error" role="status">{error}</p>}
  {data&&data.status!=='connected'&&<p className="turnstile-error" role="status">{data.status==='unconfigured'?'Configure a integração privada com iDSecure nesta instalação.':data.status==='authentication'?'O administrador precisa revisar a credencial privada da integração.':'A central não respondeu à última consulta. Os registros abaixo são os últimos recebidos.'}</p>}
  {latest?<div className="turnstile-content"><article className="turnstile-latest" aria-label="Último evento informado"><Photo event={latest} large/><div><small>ÚLTIMO EVENTO INFORMADO</small><h3>{latest.name}</h3><span className={'turnstile-event '+latest.kind}>{latest.eventName}</span><p>{latest.device}</p><p className="field-hint">Área informada: {latest.area}</p><time dateTime={latest.occurredAt}>{date(latest.occurredAt,tz)}</time>{!latest.personId&&<p className="field-hint">Cadastro ainda não vinculado ao Next Portaria.</p>}</div></article><div className="turnstile-list" aria-label="Eventos recentes da central">{events?.map(event=><div className="turnstile-row" key={event.id}><Photo event={event}/><div className="turnstile-person"><strong>{event.name}</strong><small>{event.device} · {event.area}</small><time dateTime={event.occurredAt}>{date(event.occurredAt,tz)}</time></div><span className={'turnstile-event '+event.kind}>{event.eventName}</span></div>)}</div></div>:<div className="turnstile-empty"><Activity size={26}/><p>{data?.status==='connected'?'A central não retornou eventos recentes.':data?'Nenhum evento disponível nesta consulta.':'Consultando eventos da central…'}</p></div>}
  <div className="turnstile-footer"><span><RefreshCw size={14}/>{data?.lastSuccessAt?'Última consulta recebida: '+date(data.lastSuccessAt,tz):'Aguardando primeira consulta'}{connected?'':' · sem confirmação de atualização'}</span>{(data?.events.length??0)>4&&<Button onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>{expanded?'Mostrar menos':'Ver os '+data!.events.length+' eventos recebidos'}</Button>}</div>
 </section>;
}
