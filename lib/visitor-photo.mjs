export const VISITOR_PHOTO_MAX=1999999;
export function jpegDimensions(bytes){
 const fail=()=>{throw Object.assign(Error('Use uma foto JPEG válida, com pelo menos 160 × 160 pixels e até 2 MB.'),{code:'VALIDATION'});};
 if(!(bytes instanceof Uint8Array)||bytes.length<12||bytes.length>VISITOR_PHOTO_MAX||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)fail();
 let position=2;
 while(position+4<bytes.length){
  if(bytes[position++]!==255)fail();while(bytes[position]===255)position++;const marker=bytes[position++];
  if(marker===0xda||marker===0xd9)break;
  const length=bytes[position]*256+bytes[position+1];if(length<2||position+length>bytes.length)fail();
  if([0xc0,0xc1,0xc2].includes(marker)){
   if(length<8)fail();const height=bytes[position+3]*256+bytes[position+4],width=bytes[position+5]*256+bytes[position+6];
   if(width<160||height<160||width>1920||height>1920||width*height>2073600)fail();return {width,height};
  }
  position+=length;
 }
 fail();
}
export function validateVisitorPhoto(visit){
 if(visit.visitorPhoto){const p=visit.visitorPhoto;if(typeof p.attachmentId!=='string'||!/^attachment_[\da-f-]{36}$/i.test(p.attachmentId)||!/^[a-f\d]{64}$/.test(p.sha256))throw Object.assign(Error('Referência de foto do visitante inválida.'),{code:'INVALID_BACKUP'});}
 if(visit.initialAccessScope){
  if(visit.initialAccessScope!=='gate_only'||visit.category!=='visitor'||visit.areaId||visit.responsibleUserId||visit.substituteUserId||!visit.visitorPhoto||visit.faceEnrollment?.status!=='pending_integration'||visit.faceEnrollment.scope!=='gate_only'||visit.registrationIdentityConfirmedAt!==visit.approvedAt||visit.registrationIdentityConfirmedBy!==visit.approvedBy||typeof visit.initialApprovedById!=='string')throw Object.assign(Error('Liberação inicial deve permanecer restrita à portaria, com foto e integração pendente.'),{code:'INVALID_BACKUP'});
 }
}
