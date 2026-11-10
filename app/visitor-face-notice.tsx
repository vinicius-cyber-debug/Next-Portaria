"use client";
type Visit={id?:string;name?:string;status?:string;initialAccessScope?:string;visitorPhoto?:{attachmentId:string};demoPhotoUrl?:string};
export function VisitorFaceNotice({visit,canView}:{visit?:Visit;canView:boolean}){
 if(!visit?.visitorPhoto||!canView)return null;
 const cancelled=['revoked','cancelled','denied','completed'].includes(visit.status??'');
 return <div className="visitor-face-detail">
  {/* Authenticated photos must bypass the public image optimizer. */}
  {/* eslint-disable-next-line @next/next/no-img-element */}
  <img src={visit.demoPhotoUrl?.startsWith('data:image/jpeg;base64,')?visit.demoPhotoUrl:'/api/visitor-photos/'+encodeURIComponent(visit.id??'')} alt={'Foto capturada de '+visit.name}/>
  <p className={'notice '+(visit.initialAccessScope?'warning':'info')}>{visit.initialAccessScope?(cancelled?'Autorização inicial encerrada. A foto permanece no histórico; não há cadastro facial confirmado por esta integração.':'Autorização inicial somente na portaria. Foto salva; envio facial pendente de integração validada e confirmação pelo equipamento.'):'Foto vinculada à visita para conferência da identidade.'}</p>
 </div>;
}
