"use client";
import React, {useEffect, useId, useRef} from 'react';
import {createPortal} from 'react-dom';
import {ChevronRight, FileText, LoaderCircle, X, type LucideIcon} from 'lucide-react';

export function Button({children, variant='secondary', className='', ...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string}) {
  return <button type="button" {...props} className={`button ${variant} ${className}`}>{children}</button>;
}
export function PageHeader({title, description, actions, children}:{title:React.ReactNode;description:string;actions?:React.ReactNode;children?:React.ReactNode}) {
  return <div className="page-heading"><div><h1 className="page-title">{title}</h1><p className="page-subtitle">{description}</p>{children}</div>{actions&&<div className="actions page-actions">{actions}</div>}</div>;
}
export function StatusBadge({value, children}:{value:string;children:React.ReactNode}) {
  return <span className={`status status-${value}`}><span aria-hidden="true"/>{children}</span>;
}
export function EmptyState({title='Nenhum registro encontrado', text, icon:Icon=FileText}:{title?:string;text:React.ReactNode;icon?:LucideIcon}) {
  return <div className="empty"><div className="empty-icon"><Icon size={24} aria-hidden="true"/></div><h3 className="empty-title">{title}</h3>{text&&<p className="empty-text">{text}</p>}</div>;
}
export function LoadingState({children='Consultando registros…'}:{children?:React.ReactNode}) {
  return <div className="record-loader" role="status"><LoaderCircle size={20} className="spinning" aria-hidden="true"/>{children}<div className="loading-skeleton" aria-hidden="true"><i/><i/><i/></div></div>;
}
export function StatCard({title, value, detail, icon:Icon, tone='blue', selected, onClick}:{title:string;value:React.ReactNode;detail:string;icon:LucideIcon;tone?:string;selected?:boolean;onClick?:()=>void}) {
  const content=<><span className="stat-icon"><Icon size={21} aria-hidden="true"/></span><span className="stat-copy"><span className="stat-label">{title}</span><strong className="stat-value">{value}</strong><span className="stat-detail">{detail}</span></span>{onClick&&<ChevronRight size={16} className="stat-arrow" aria-hidden="true"/>}</>;
  return onClick?<button type="button" className={`stat-card tone-${tone} ${selected?'selected':''}`} aria-pressed={selected} onClick={onClick}>{content}</button>:<div className={`stat-card tone-${tone}`}>{content}</div>;
}
export function SearchField({label, children, className=''}:{label:string;children:React.ReactNode;className?:string}) {
  return <div className={`search-field ${className}`} role="search" aria-label={label}>{children}</div>;
}
export function FormSection({title,children}:{title:string;children:React.ReactNode}) {
  return <fieldset className="form-section"><legend className="form-step-heading" tabIndex={-1}>{title}</legend><div className="form-grid">{children}</div></fieldset>;
}
export function FormField({label, children, hint, full=false}:{label:React.ReactNode;children:React.ReactNode;hint?:string;full?:boolean}) {
  const generatedId=useId(),hintId=generatedId+'-hint';
  const control=React.isValidElement<{id?:string;'aria-describedby'?:string}>(children)?children:null;
  const id=control?.props.id||generatedId;
  return <div className={`form-field ${full?'full':''}`}><label className="field-label" htmlFor={id}>{label}</label>{control?React.cloneElement(control,{id,...(hint?{'aria-describedby':hintId}:{})}):children}{hint&&<span id={hintId} className="field-hint">{hint}</span>}</div>;
}
/** Only presentation and focus management. Confirmation rules stay with each operation. */
export function ModalFrame({title, children, onClose, wide=false}:{title:string;children:React.ReactNode;onClose:()=>void;wide?:boolean}) {
  const id=useId(),ref=useRef<HTMLDivElement>(null),close=useRef(onClose);
  useEffect(()=>{close.current=onClose},[onClose]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const background:{element:HTMLElement;inert:boolean}[]=[];
    // Exclude the background from keyboard and assistive navigation, including nested panels.
    for(let branch=ref.current?.parentElement;branch&&branch!==document.body;branch=branch.parentElement){
      for(const sibling of branch.parentElement?.children||[]){
        if(sibling!==branch&&sibling instanceof HTMLElement){background.push({element:sibling,inert:sibling.inert});sibling.inert=true}
      }
    }
    const nodes=()=>Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')||[]).filter(el=>el.getClientRects().length&&!el.closest('[inert]'));
    (ref.current?.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')||nodes()[0]||ref.current)?.focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();close.current()}
      if(event.key==='Tab'){
        const elements=nodes(),first=elements[0],last=elements.at(-1);
        if(!first){event.preventDefault();ref.current?.focus();return}
        if(event.shiftKey&&(document.activeElement===first||!ref.current?.contains(document.activeElement))){event.preventDefault();last?.focus()}
        else if(!event.shiftKey&&(document.activeElement===last||!ref.current?.contains(document.activeElement))){event.preventDefault();first.focus()}
      }
    };
    document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('keydown',key);document.body.style.overflow=overflow;for(const item of background)item.element.inert=item.inert;if(previous?.isConnected)previous.focus()};
  },[]);
  return createPortal(<div className="modal-overlay"><div ref={ref} className={`modal-dialog ${wide?'wide':''}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}><div className="modal-header"><h2 className="modal-title" id={id}>{title}</h2><button type="button" className="close-button" aria-label="Fechar" onClick={onClose}><X size={20}/></button></div>{children}</div></div>,document.body);
}
export function DataTable({children, busy=false}:{children:React.ReactNode;busy?:boolean}) {
  return <div className="table-wrap" aria-busy={busy} tabIndex={0} role="region" aria-label="Tabela de registros. Role para ver todas as colunas.">{children}</div>;
}
