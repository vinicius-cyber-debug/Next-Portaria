import {IdSecureReader} from './idsecure.ts';
import {validateSchedule} from './access-schedule.mjs';
type ScheduleRule=Parameters<typeof validateSchedule>[0];
const normalized=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toUpperCase();
/** Directory/device checks only. Reader direction still needs a physical mapping test. */
export async function inspectScheduleSource(rule:ScheduleRule,reader:IdSecureReader){
 validateSchedule(rule);if(reader.sourceId!==rule.subject.sourceId)throw Error('Fonte da autorização mudou.');
 const devices=await reader.readDevices(),device=devices.find(item=>item.id===rule.target.deviceId);
 if(!device||device.name!==rule.target.expectedName||device.model!==rule.target.model||device.firmware!==rule.target.firmware)throw Error('Equipamento, modelo ou firmware diferente do destino fixado.');
 if(!device.online)throw Error('A central informa que o equipamento está offline.');
 for(let offset=0;offset<100000;){
  const page=await reader.readPage(offset,100),person=page.items.find(item=>item.nativeId===rule.subject.nativeUserId);
  if(person){if(normalized(person.name)!==normalized(rule.subject.expectedName)||person.inactive||person.blocked||person.visitor)throw Error('O funcionário da central não confere ou está indisponível.');return {checkedAt:new Date().toISOString(),status:'directory_and_device_match',readerDirection:'awaiting_physical_validation',hardwareWrites:0};}
  if(!page.items.length||offset+page.items.length>=page.total)break;
  offset+=page.items.length;
 }
 throw Error('Funcionário não encontrado na central.');
}
