import {assertVisitEligibility} from '../physical-access.mjs';
import {validateVisitorPhoto} from '../visitor-photo.mjs';
/** A read-only integration plan. It does not register faces, grant access or open a gate. */
export function visitorFacePlan(state,config,devices,at=new Date().toISOString()){
 if(config.mode!=='prepared'||config.scope!=='gate_only'||config.hardwareWritesEnabled!==false||!/^\d+$/.test(config.targetDeviceId))throw Error('A preparação facial deve permanecer restrita e sem escrita física.');
 const matches=devices.filter(device=>device.id===config.targetDeviceId);
 if(matches.length!==1||matches[0].name!==config.targetName||matches[0].model!==config.model||matches[0].firmware!==config.firmware)throw Error('O destino físico mudou. Revalide modelo, firmware e mapeamento da portaria.');
 const requests=state.visitors.filter(visit=>visit.initialAccessScope==='gate_only').map(visit=>{
  validateVisitorPhoto(visit);let status='awaiting_integration_validation';
  if(visit.status!=='authorized'||Date.parse(visit.validUntil)<=Date.parse(at))status='inactive';
  else if(Date.parse(visit.expectedAt)>Date.parse(at))status='scheduled';
  else{try{const person=assertVisitEligibility(state,visit,at);if(person?.category!=='visitor')status='blocked';}catch{status='blocked';}}
  return {visitorId:visit.id,photoAttachmentId:visit.visitorPhoto.attachmentId,targetDeviceId:config.targetDeviceId,validFrom:visit.expectedAt,validUntil:visit.validUntil,status};
 });
 return {target:{id:config.targetDeviceId,name:config.targetName,model:config.model,firmware:config.firmware},hardwareWritesEnabled:false,requests};
}
