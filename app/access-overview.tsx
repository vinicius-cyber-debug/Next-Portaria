"use client";
import type {ReactNode} from 'react';
import {ArrowRight, History, LogIn, LogOut, Users} from 'lucide-react';
import {EmptyState} from './ui';

type Person={id:string;name:string;company:string;detail:string;action?:ReactNode};
type Movement={id:string;personId:string;name:string;company:string;time:string;dateTime:string;kind:'entry'|'exit'};
type Props={present:Person[];pending:Person[];movements:Movement[];presentCount:number;pendingCount:number;onOpen:(id:string)=>void;onView:(view:string)=>void};

/** A compact projection of existing records. Permissions and commands stay in CentralAccess. */
export function AccessOverview({present,pending,movements,presentCount,pendingCount,onOpen,onView}:Props){
  return <div className="access-overview">
    <section className="card overview-movements" aria-labelledby="recent-movements-title">
      <div className="card-header"><h2 className="card-title" id="recent-movements-title"><History size={18}/>Movimentações recentes</h2><button type="button" className="section-link" onClick={()=>onView('all')}>Ver histórico<ArrowRight size={15}/></button></div>
      {movements.length?<div className="overview-movement-list">{movements.map(event=><button type="button" className="overview-movement" key={event.id} onClick={()=>onOpen(event.personId)}><span className={'movement-direction '+event.kind}>{event.kind==='entry'?<LogIn size={18}/>:<LogOut size={18}/>}</span><span className="overview-person"><strong>{event.name}</strong><small><span className="movement-kind">{event.kind==='entry'?'Entrada':'Saída'} · </span>{event.company||'Sem empresa'}</small></span><span className={'status status-'+(event.kind==='entry'?'inside':'completed')}>{event.kind==='entry'?'Entrada':'Saída'}</span><time dateTime={event.dateTime}>{event.time}</time></button>)}</div>:<EmptyState title="Sem movimentações" text="Entradas e saídas conferidas na portaria aparecerão aqui."/>}
      <p className="overview-footnote">Registros da janela operacional. Autorizar um acesso não registra entrada.</p>
    </section>
    <section className="card overview-attention" aria-label="Pendências e pessoas presentes">
      <div className="overview-section">
        <div className="overview-section-heading"><h2>Aguardando aprovação <span>{pendingCount}</span></h2><button type="button" className="section-link" onClick={()=>onView('pending')}>Ver todas<ArrowRight size={15}/></button></div>
        {pending.length?pending.map(person=><div className="overview-person-row" key={person.id}><button type="button" className="overview-person" onClick={()=>onOpen(person.id)}><strong>{person.name}</strong><small>{person.detail}</small></button>{person.action}</div>):<p className="overview-clear">Nenhuma solicitação pendente.</p>}
      </div>
      <div className="overview-section">
        <div className="overview-section-heading"><h2><Users size={17}/>Pessoas presentes <span>{presentCount}</span></h2><button type="button" className="section-link" onClick={()=>onView('inside')}>Ver lista<ArrowRight size={15}/></button></div>
        {present.length?present.map(person=><div className="overview-person-row" key={person.id}><button type="button" className="overview-person" onClick={()=>onOpen(person.id)}><strong>{person.name}</strong><small>{person.detail}</small></button>{person.action}</div>):<p className="overview-clear">Nenhuma pessoa registrada na instalação.</p>}
      </div>
    </section>
  </div>;
}
