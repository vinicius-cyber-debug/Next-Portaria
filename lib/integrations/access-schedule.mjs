import {createHash} from 'node:crypto';

const fail=message=>{throw Object.assign(Error(message),{code:'INVALID_SCHEDULE'});};
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const externalId=value=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value);
function seconds(value){if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))fail('Horário deve usar HH:MM.');const [hour,minute]=value.split(':').map(Number);return hour*3600+minute*60;}

export function validateSchedule(rule){
 if(!rule||typeof rule!=='object'||Array.isArray(rule)||!identifier(rule.id)||!Number.isSafeInteger(rule.version)||rule.version<1||typeof rule.enabled!=='boolean')fail('Regra de horário inválida.');
 if(rule.timeZone!=='America/Manaus')fail('Configure explicitamente o fuso America/Manaus.');
 if(!identifier(rule.subject?.personId)||!identifier(rule.subject?.sourceId)||!externalId(rule.subject?.nativeUserId)||typeof rule.subject?.expectedName!=='string'||!rule.subject.expectedName.trim()||rule.subject.expectedName.length>150)fail('Vínculo individual do funcionário inválido.');
 if(!externalId(rule.target?.deviceId)||!externalId(rule.target?.readerId)||rule.target?.direction!=='exit'||typeof rule.target.expectedName!=='string'||!rule.target.expectedName.trim()||!Number.isSafeInteger(rule.target.model)||typeof rule.target.firmware!=='string'||!rule.target.firmware)fail('Fixe equipamento, leitora e sentido de saída.');
 if(!Array.isArray(rule.days)||!rule.days.length||rule.days.length>7||new Set(rule.days).size!==rule.days.length||rule.days.some(day=>!Number.isInteger(day)||day<1||day>7))fail('Dias usam ISO: segunda=1 até domingo=7.');
 if(!Array.isArray(rule.windows)||!rule.windows.length||rule.windows.length>12)fail('Defina os intervalos de restrição.');
 const windows=rule.windows.map(window=>({start:seconds(window.start),end:seconds(window.end)})).sort((a,b)=>a.start-b.start);
 if(windows.some((window,index)=>window.start>=window.end||index&&windows[index-1].end>window.start))fail('Intervalos devem ter fim posterior ao início, sem sobreposição ou virada de dia.');
 return rule;
}

export function scheduleDecision(rule,at=new Date().toISOString()){
 validateSchedule(rule);
 if(typeof at!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at)||!Number.isFinite(Date.parse(at)))fail('Instante deve incluir fuso explícito.');
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:rule.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(part=>[part.type,part.value]));
 const date=`${parts.year}-${parts.month}-${parts.day}`,day=new Date(date+'T12:00:00Z').getUTCDay()||7,time=Number(parts.hour)*3600+Number(parts.minute)*60+Number(parts.second);
 const restricted=rule.enabled&&rule.days.includes(day)&&rule.windows.some(window=>time>=seconds(window.start)&&time<seconds(window.end));
 // "baseline" restores the saved permission baseline, never an unconditional grant.
 const desired=restricted?'restrict_exit':'baseline',scope={sourceId:rule.subject.sourceId,nativeUserId:rule.subject.nativeUserId,deviceId:rule.target.deviceId,readerId:rule.target.readerId,direction:'exit'};
 const policyHash=createHash('sha256').update(JSON.stringify(rule)).digest('hex');
 return {ruleId:rule.id,version:rule.version,policyHash,scope,desired,checkedAt:new Date(at).toISOString(),localDate:date,localTime:`${parts.hour}:${parts.minute}:${parts.second}`,day,timeZone:rule.timeZone};
}

export function validateScheduleConfig(config){
 if(config?.version!==1||config.mode!=='preview'||config.hardwareWritesEnabled!==false)fail('Envio físico não homologado. Somente mode=preview e hardwareWritesEnabled=false estão disponíveis.');
 if(!Number.isInteger(config.pollSeconds)||config.pollSeconds<10||config.pollSeconds>300)fail('Intervalo de consulta deve ser de 10 a 300 segundos.');
 validateSchedule(config.rule);return config;
}

/** Test-only reconciliation. It cannot be connected to a live adapter. */
export async function reconcileSimulatedSchedule(rule,adapter,at){
 const decision=scheduleDecision(rule,at);
 if(adapter?.mode!=='simulation'||adapter.hardwareConnected!==false)throw Object.assign(Error('Reconciliação disponível apenas no simulador isolado.'),{code:'UNVERIFIED_ADAPTER'});
 const before=await adapter.read(decision.scope);let changed=false;
 if(before.desired!==decision.desired){await adapter.apply({...decision,idempotencyKey:createHash('sha256').update(JSON.stringify([decision.policyHash,decision.scope,decision.desired,before.revision])).digest('hex')});changed=true;}
 const after=await adapter.read(decision.scope);
 if(after.desired!==decision.desired)throw Object.assign(Error('Estado previsto não foi confirmado nem no simulador.'),{code:'READBACK_MISMATCH'});
 return {...decision,mode:'simulation',status:'confirmed_in_simulation',changed,hardwareWrites:0};
}
