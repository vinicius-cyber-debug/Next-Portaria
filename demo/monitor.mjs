function avatar(name,index){
 const initials=name.split(' ').slice(0,2).map(word=>word[0]).join('').toUpperCase(),colors=['#dbeafe','#ccfbf1','#ede9fe','#ffedd5'];
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200" viewBox="0 0 160 200"><rect width="160" height="200" rx="12" fill="${colors[index%colors.length]}"/><circle cx="80" cy="66" r="30" fill="#64748b" opacity=".35"/><path d="M25 160c0-48 110-48 110 0v40H25z" fill="#64748b" opacity=".35"/><text x="80" y="180" text-anchor="middle" fill="#102542" font-family="Arial" font-size="28" font-weight="bold">${initials}</text></svg>`;
 return 'data:image/svg+xml,'+encodeURIComponent(svg);
}
/** Entirely synthetic, clock-driven feed. Never opens a network connection or changes presence. */
export function demoMonitor(state,now,startedAt){
 const milliseconds=Date.parse(now),tick=Math.max(0,Math.floor((milliseconds-startedAt)/12000)),base=startedAt+tick*12000;
 const variants=[['authorized','Acesso autorizado'],['authorized','Acesso autorizado'],['pending','Acesso pendente'],['denied','Acesso negado'],['authorized','Acesso autorizado'],['unidentified','Identificação não reconhecida']];
 return {source:'Simulação para apresentação',mode:'simulation',status:'connected',lastSuccessAt:now,pollIntervalMs:3000,passageEvidence:'not_validated',events:Array.from({length:8},(_,index)=>{
  const person=state.people[(tick+index)%state.people.length],[kind,eventName]=variants[(tick+index)%variants.length];
  return {id:'demo-monitor-'+tick+'-'+index,personId:person.id,name:person.name,photoUrl:avatar(person.name,index),device:index%2?'Catraca de serviços · fictícia':'Catraca principal · fictícia',area:index%2?'Área externa · demonstração':'Recepção · demonstração',occurredAt:new Date(base-index*60000).toISOString(),eventName,kind,passageConfirmed:false};
 })};
}
