import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateSchedule,validateScheduleConfig,scheduleDecision,reconcileSimulatedSchedule} from '../lib/integrations/access-schedule.mjs';
import {inspectScheduleSource} from '../lib/integrations/access-schedule-probe.ts';
import {previewSchedule,acquireScheduleLock,writeScheduleStatus} from '../scripts/access-schedule-worker.mjs';

const rule=()=>({id:'qa-production-exit',version:1,enabled:true,timeZone:'America/Manaus',subject:{personId:'qa-employee',sourceId:'fixture',nativeUserId:'9007199254740993',expectedName:'Funcionário Fictício'},target:{deviceId:'2',readerId:'4',direction:'exit',expectedName:'Portaria QA',model:17,firmware:'fixture'},days:[1,2,3,4,5,6],windows:[{start:'07:30',end:'11:00'},{start:'13:30',end:'17:00'}]});
const config=()=>({version:1,mode:'preview',hardwareWritesEnabled:false,pollSeconds:30,rule:rule()});
const at=time=>'2026-11-10T'+time+'-04:00';

test('intervalos incluem início e excluem fim no fuso de Manaus',()=>{
 for(const [time,restricted] of [['07:29:59',false],['07:30:00',true],['10:59:59',true],['11:00:00',false],['13:29:59',false],['13:30:00',true],['16:59:59',true],['17:00:00',false],['23:59:59',false]])assert.equal(scheduleDecision(rule(),at(time)).desired,restricted?'restrict_exit':'baseline',time);
 assert.equal(scheduleDecision(rule(),'2026-11-10T11:30:00Z').desired,'restrict_exit');
 assert.equal(scheduleDecision(rule(),'2026-11-10T15:00:00Z').desired,'baseline');
 assert.throws(()=>scheduleDecision(rule(),'2026-11-10T07:30:00'));
});
test('segunda a sábado restringe; domingo e desativação restauram somente a base',()=>{
 for(const day of ['09','10','11','12','13','14'])assert.equal(scheduleDecision(rule(),`2026-11-${day}T08:00:00-04:00`).desired,'restrict_exit');
 assert.equal(scheduleDecision(rule(),'2026-11-15T08:00:00-04:00').desired,'baseline');
 assert.equal(scheduleDecision({...rule(),enabled:false},at('08:00:00')).desired,'baseline');
});
test('recusa horários ambíguos, escopo amplo, IDs inseguros e habilitação física',()=>{
 for(const change of [{windows:[{start:'11:00',end:'07:30'}]},{windows:[{start:'07:30',end:'11:00'},{start:'10:00',end:'12:00'}]},{windows:[{start:'24:00',end:'25:00'}]},{days:[1,1]},{days:[0]},{timeZone:'UTC'},{target:{...rule().target,direction:'both'}},{subject:{...rule().subject,nativeUserId:9007199254740992}}])assert.throws(()=>validateSchedule({...rule(),...change}));
 for(const change of [{mode:'live'},{hardwareWritesEnabled:true},{pollSeconds:0}])assert.throws(()=>validateScheduleConfig({...config(),...change}));
});
class SimulatedPermissions{
 mode='simulation';hardwareConnected=false;revision=0;writes=0;desired='baseline';broken=false;
 baseline={entry:true,exit:true,otherDevice:true,otherPerson:true};current=structuredClone(this.baseline);
 async read(){return {desired:this.desired,revision:this.revision};}
 async apply(command){this.writes++;if(this.broken)return;this.desired=command.desired;this.current={...this.baseline,exit:command.desired==='baseline'?this.baseline.exit:false};this.revision++;this.last=command;}
}
test('sequência isolada restringe somente saída, confirma e restaura base; reinício reconcilia',async()=>{
 const adapter=new SimulatedPermissions();let result=await reconcileSimulatedSchedule(rule(),adapter,at('08:00:00'));
 assert.equal(result.status,'confirmed_in_simulation');assert.equal(result.hardwareWrites,0);assert.deepEqual(adapter.current,{entry:true,exit:false,otherDevice:true,otherPerson:true});assert.equal(adapter.last.scope.nativeUserId,'9007199254740993');
 assert.equal((await reconcileSimulatedSchedule(rule(),adapter,at('08:05:00'))).changed,false);assert.equal(adapter.writes,1);
 await reconcileSimulatedSchedule(rule(),adapter,at('11:00:00'));assert.deepEqual(adapter.current,adapter.baseline);
 // No transition event is required: restart in an active window repairs current drift.
 await reconcileSimulatedSchedule(rule(),adapter,at('14:00:00'));assert.equal(adapter.current.exit,false);
 await reconcileSimulatedSchedule(rule(),adapter,at('17:00:00'));assert.deepEqual(adapter.current,adapter.baseline);
 adapter.baseline.exit=false;await reconcileSimulatedSchedule(rule(),adapter,at('14:00:00'));await reconcileSimulatedSchedule(rule(),adapter,at('17:00:00'));assert.equal(adapter.current.exit,false);
});
test('consulta falha e confirmação divergente não são apresentadas como aplicação concluída',async()=>{
 const adapter=new SimulatedPermissions();adapter.broken=true;await assert.rejects(reconcileSimulatedSchedule(rule(),adapter,at('08:00:00')),{code:'READBACK_MISMATCH'});
 adapter.broken=false;adapter.read=async()=>{throw Error('Offline');};await assert.rejects(reconcileSimulatedSchedule(rule(),adapter,at('08:00:00')));assert.equal(adapter.writes,1);
 await assert.rejects(reconcileSimulatedSchedule(rule(),{mode:'live'},at('08:00:00')),{code:'UNVERIFIED_ADAPTER'});
});
test('worker de prévia distingue fonte verificada, fonte indisponível e envio ainda ausente',async()=>{
 const healthy=await previewSchedule(config(),async()=>({status:'directory_and_device_match',hardwareWrites:0}),at('08:00:00'));
 assert.equal(healthy.desired,'restrict_exit');assert.equal(healthy.status,'awaiting_write_adapter');assert.equal(healthy.applied,false);assert.equal(healthy.hardwareWrites,0);
 const failed=await previewSchedule(config(),async()=>{throw Error('senha-nao-deve-aparecer');},at('08:00:00'));assert.equal(failed.status,'source_unavailable_or_changed');assert.equal(failed.applied,false);assert.ok(!JSON.stringify(failed).includes('senha-nao'));
 const auth=await previewSchedule(config(),async()=>{throw Object.assign(Error('Segredo'),{kind:'authentication'});},at('08:00:00'));assert.equal(auth.failureKind,'authentication');assert.ok(!JSON.stringify(auth).includes('Segredo'));
 let calls=0;await assert.rejects(previewSchedule({...config(),hardwareWritesEnabled:true},async()=>{calls++;}));assert.equal(calls,0);
});
const source=()=>({sourceId:'fixture',async readDevices(){return [{id:'2',name:'Portaria QA',model:17,firmware:'fixture',online:true}];},async readPage(offset){return {total:101,items:offset===0?[{nativeId:'1'}]:[{nativeId:'9007199254740993',name:'FUNCIONARIO FICTICIO',inactive:false,blocked:false,visitor:false}]};}});
test('consulta somente leitura fixa identidade, equipamento, firmware e recusa bloqueio/offline',async()=>{
 const reader=source(),offsets=[],originalRead=reader.readPage;reader.readPage=async offset=>{offsets.push(offset);return originalRead(offset);};const result=await inspectScheduleSource(rule(),reader);assert.equal(result.status,'directory_and_device_match');assert.equal(result.readerDirection,'awaiting_physical_validation');assert.deepEqual(offsets,[0,1]);
 for(const change of [{sourceId:'outro'},{readDevices:async()=>[{id:'2',name:'Portaria QA',model:17,firmware:'changed',online:true}]},{readDevices:async()=>[{id:'2',name:'Portaria QA',model:17,firmware:'fixture',online:false}]},{readPage:async()=>({items:[{nativeId:'9007199254740993',name:'Outra pessoa'}],total:1})}])await assert.rejects(inspectScheduleSource(rule(),{...source(),...change}));
});
test('estado durável é legível após reinício; segunda instância não toma o bloqueio',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'portaria-schedule-test-')),path=join(folder,'status.json');let unlock;
 try{unlock=await acquireScheduleLock(path+'.lock');await assert.rejects(acquireScheduleLock(path+'.lock'));
 const status=await previewSchedule(config(),async()=>({status:'fixture'}),at('08:00:00'));await writeScheduleStatus(path,status);assert.equal(JSON.parse(await readFile(path,'utf8')).applied,false);
 await unlock();unlock=null;unlock=await acquireScheduleLock(path+'.lock');
 }finally{if(unlock)await unlock();await rm(folder,{recursive:true});}
});
