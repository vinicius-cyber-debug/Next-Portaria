import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import PortApp from '../app/port-app';
import { setRequestTransport } from '../lib/http-client';
import { createDemoApi } from './api.mjs';
import '../app/globals.css';
import './styles.css';

const demo=createDemoApi({origin:window.location.origin});
setRequestTransport(demo.request);

function Demonstration() {
  const [message,setMessage]=useState('');
  function guardNavigation(event:React.MouseEvent<HTMLDivElement>) {
    const target=event.target instanceof Element?event.target:null;
    const anchor=target?.closest('a[href]');
    const button=target?.closest('button');
    const buttonLabel=(button?.getAttribute('aria-label')||button?.textContent||'').trim();
    if(anchor&&new URL(anchor.getAttribute('href')||'',window.location.href).pathname.startsWith('/api/')||buttonLabel==='Sair do sistema') {
      event.preventDefault();event.stopPropagation();
      setMessage('Esta é uma demonstração isolada. Arquivos privados e contas reais não estão disponíveis.');
    }
  }
  return <div className="demo-shell" onClickCapture={guardNavigation}>
    <aside className="demo-banner" aria-label="Ambiente de demonstração"><div><strong>Demonstração interativa</strong><span>Dados fictícios · alterações apenas nesta aba</span></div><button type="button" onClick={()=>window.location.reload()}>Reiniciar demo</button></aside>
    {message&&<div className="demo-message" role="status"><span>{message}</span><button type="button" onClick={()=>setMessage('')} aria-label="Fechar aviso da demonstração">×</button></div>}
    <PortApp />
  </div>;
}

createRoot(document.getElementById('root')!).render(<Demonstration />);
