"use client";
import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {ChevronRight, LockKeyhole, LogOut, Menu, PanelLeftClose, PanelLeftOpen, X, type LucideIcon} from 'lucide-react';
import {BrandMark} from './brand-mark';

type NavigationItem={id:string;title:string;icon:LucideIcon;count?:number;group?:string};
type Identity={name:string;role:string;initials:string};
const mediaQuery='(max-width: 900px)';
const subscribeMedia=(notify:()=>void)=>{const query=matchMedia(mediaQuery);query.addEventListener('change',notify);return()=>query.removeEventListener('change',notify)};
const mobileSnapshot=()=>matchMedia(mediaQuery).matches;
function Sidebar({items, active, unit, user, onNavigate, onLogout, close, sidebarRef, mobileOpen, mobile}:{items:NavigationItem[];active:string;unit:string;user:Identity;onNavigate:(id:string)=>void;onLogout:()=>void;close:()=>void;sidebarRef:React.RefObject<HTMLElement|null>;mobileOpen:boolean;mobile:boolean}) {
  return <aside ref={sidebarRef} className={`sidebar ${mobileOpen?'open':''}`} id="app-navigation" aria-label="Menu da unidade" role={mobile&&mobileOpen?'dialog':undefined} aria-modal={mobile&&mobileOpen?true:undefined} inert={mobile&&!mobileOpen}>
    <div className="sidebar-brand-row"><button type="button" className="brand" onClick={()=>onNavigate('dashboard')} aria-label="Next Portaria · Visão geral"><span className="brand-icon"><BrandMark size={27}/></span><span className="brand-word">next<span>PORTARIA</span></span></button><button type="button" className="icon-button drawer-close" onClick={close} aria-label="Fechar menu"><X size={20}/></button></div>
    <div className="sidebar-unit" title={unit}><span className="live-dot"/><span>{unit}</span></div>
    <nav aria-label="Navegação principal"><div className="nav-label">OPERAÇÃO</div>{items.map(item=><React.Fragment key={item.id}>{item.group&&<div className="nav-label">{item.group}</div>}<button type="button" className={`nav-item ${active===item.id?'active':''}`} aria-current={active===item.id?'page':undefined} aria-label={item.title} title={item.title} onClick={()=>onNavigate(item.id)}><item.icon size={19}/><span className="nav-text">{item.title}</span>{!!item.count&&<span className="nav-count">{item.count}</span>}</button></React.Fragment>)}</nav>
    <div className="sidebar-bottom"><button type="button" className={`nav-item ${active==='password'?'active':''}`} aria-label="Minha senha" title="Minha senha" onClick={()=>onNavigate('password')}><LockKeyhole size={19}/><span className="nav-text">Minha senha</span></button><div className="identity"><span className="identity-avatar" title={user.name}>{user.initials}</span><div className="identity-copy"><strong title={user.name}>{user.name}</strong><small>{user.role}</small></div><button type="button" className="icon-button" aria-label="Sair do sistema" title="Sair do sistema" onClick={onLogout}><LogOut size={18}/></button></div></div>
  </aside>;
}
function Topbar({title, unit, toggle, expanded, mobile, children}:{title:string;unit:string;toggle:()=>void;expanded:boolean;mobile:boolean;children:React.ReactNode}) {
  const label=mobile?'Abrir menu':expanded?'Recolher menu':'Expandir menu';
  return <header className="topbar"><button type="button" className="icon-button menu-toggle" aria-label={label} title={label} aria-expanded={expanded} aria-controls="app-navigation" onClick={toggle}>{mobile?<Menu size={20}/>:expanded?<PanelLeftClose size={20}/>:<PanelLeftOpen size={20}/>}</button><div className="breadcrumb" aria-label="Localização"><span className="breadcrumb-home" title={unit}>{unit}</span><ChevronRight size={14}/><strong>{title}</strong></div>{children}</header>;
}
export function AppShell({items, active, unit, user, onNavigate, onLogout, title, topbar, children}:{items:NavigationItem[];active:string;unit:string;user:Identity;onNavigate:(id:string)=>void;onLogout:()=>void;title:string;topbar:React.ReactNode;children:React.ReactNode}) {
  const [collapsed,setCollapsed]=useState(false),[open,setOpen]=useState(false),ref=useRef<HTMLElement>(null);
  const mobile=useSyncExternalStore(subscribeMedia,mobileSnapshot,()=>false);
  useEffect(()=>subscribeMedia(()=>setOpen(false)),[]);
  useEffect(()=>{
    if(!mobile||!open)return;
    const previous=document.activeElement as HTMLElement,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';ref.current?.querySelector<HTMLElement>('button')?.focus();
    const handler=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);if(e.key==='Tab'){const elements=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)')||[]).filter(el=>el.getClientRects().length),first=elements[0],last=elements.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}};
    document.addEventListener('keydown',handler);return()=>{document.removeEventListener('keydown',handler);document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus()};
  },[mobile,open]);
  function toggle(){if(mobile)setOpen(!open);else setCollapsed(!collapsed)}
  return <div className={`app-shell ${collapsed?'sidebar-collapsed':''}`}><a className="skip-link" href="#main-content">Ir para o conteúdo</a>{mobile&&open&&<div className="sidebar-shade" onClick={()=>setOpen(false)} aria-hidden="true"/>}<Sidebar {...{items,active,unit,user,mobile}} sidebarRef={ref} mobileOpen={open} close={()=>setOpen(false)} onNavigate={id=>{onNavigate(id);setOpen(false)}} onLogout={onLogout}/><div className="workspace" inert={mobile&&open}><Topbar {...{title,unit,mobile}} expanded={mobile?open:!collapsed} toggle={toggle}>{topbar}</Topbar>{children}</div></div>;
}
