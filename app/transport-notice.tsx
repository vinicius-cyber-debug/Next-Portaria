"use client";

import { ArrowRight, RefreshCw, ShieldCheck } from 'lucide-react';
import { BrandMark } from './brand-mark';

export function HttpsRequiredScreen({ message }: { message: string }) {
  const port = typeof window === 'undefined' ? '5173' : window.location.port;
  const localUrl = `http://127.0.0.1${port ? ':' + port : ''}/`;

  return <div className="auth-screen">
    <div className="auth-card">
      <div className="auth-mark"><BrandMark size={32}/></div>
      <span className="eyebrow">NEXT PORTARIA</span>
      <h1>Acesso pela rede exige HTTPS.</h1>
      <p>{message}</p>
      <p>Se você está no computador onde o servidor foi iniciado, abra o endereço local:</p>
      <a className="button primary" href={localUrl}>Abrir acesso local<ArrowRight size={18}/></a>
      <p className="field-hint">{localUrl} funciona no computador do servidor. Em outra estação da rede, use o endereço HTTPS configurado para esta instalação.</p>
      <button className="button secondary" type="button" onClick={() => window.location.reload()}><RefreshCw size={17}/>Verificar novamente</button>
      <div className="auth-footer"><ShieldCheck size={15}/>Acesso privado · Permissões por perfil</div>
    </div>
    <div className="auth-decoration" aria-hidden="true"><BrandMark size={280}/></div>
  </div>;
}
