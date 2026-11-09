export function validateDirectoryPerson(person){
 const fail=()=>{throw Object.assign(Error('Vínculo ou foto do diretório inválido.'),{code:'INVALID_BACKUP'});};
 const d=person.directory;
 if(d){
  if(!/^[a-z0-9_-]{2,60}$/.test(d.sourceId)||!/^\d{1,20}$/.test(d.nativeId)||!/^\d{1,20}$/.test(d.recordId)||BigInt(d.nativeId)<1n||BigInt(d.recordId)<1n||typeof d.registration!=='string'||d.registration.length>80||['inactive','blocked','missing'].some(k=>typeof d[k]!=='boolean'))fail();
 }
 const p=person.directoryPhoto;
 if(p){
  if(!d||!Number.isSafeInteger(p.size)||p.size<1||p.size>4*1024*1024||!['image/jpeg','image/png','image/webp'].includes(p.contentType)||!/^[a-f0-9]{64}$/.test(p.sha256)||p.objectKey!==`directory-photos/${d.sourceId}/${p.sha256}`)fail();
 }
 return person;
}
