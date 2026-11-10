import {readFile,writeFile,rename,mkdir,open,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateScheduleConfig,scheduleDecision} from '../lib/integrations/access-schedule.mjs';
import {IdSecureReader} from '../lib/integrations/idsecure.ts';
import {inspectScheduleSource} from '../lib/integrations/access-schedule-probe.ts';

export async function writeScheduleStatus(path,value){
 await mkdir(dirname(path),{recursive:true});const temporary=path+'.'+randomUUID()+'.tmp';
 try{await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}
}
export async function previewSchedule(config,inspect,at=new Date().toISOString()){
 validateScheduleConfig(config);const decision=scheduleDecision(config.rule,at);
 try{const source=await inspect(config.rule);return {...decision,mode:'preview',status:'awaiting_write_adapter',source,applied:false,hardwareWrites:0};}
 catch(error){const failureKind=['offline','timeout','authentication','unsupported','invalid_input'].includes(error?.kind)?error.kind:'changed_or_unknown';return {...decision,mode:'preview',status:'source_unavailable_or_changed',failureKind,applied:false,hardwareWrites:0};}
}
export async function acquireScheduleLock(path){
 await mkdir(dirname(path),{recursive:true});let lock;
 try{lock=await open(path,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Error('Já existe um worker ou um bloqueio residual. Confira o processo antes de remover o arquivo .lock.');throw error;}
 try{await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));}catch(error){await lock.close();await unlink(path).catch(()=>{});throw error;}
 return async()=>{await lock.close();await unlink(path);};
}
async function main(){
 const args=process.argv.slice(2);if(args.some(arg=>!['--once'].includes(arg)))throw Error('Use --once ou execute sem argumentos para acompanhar continuamente.');
 const configPath=resolve(process.env.PORTO_ACCESS_SCHEDULE_CONFIG??'.porto-runtime/access-schedule.json');
 const statusPath=resolve(process.env.PORTO_ACCESS_SCHEDULE_STATUS??'.porto-runtime/access-schedule-status.json');
 const sourcePath=resolve(process.env.PORTO_IDSECURE_CONFIG??'.porto-runtime/idsecure.json');
 if(new Set([configPath,statusPath,sourcePath].map(path=>process.platform==='win32'?path.toLowerCase():path)).size!==3)throw Error('Configuração, estado e credenciais precisam de arquivos separados.');
 validateScheduleConfig(JSON.parse(await readFile(configPath,'utf8')));
 const unlock=await acquireScheduleLock(statusPath+'.lock');let stopping=false,wake,lastSummary,failures=0;
 const stop=()=>{stopping=true;wake?.();};for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
 try{
  do{
   // Reload on every cycle: a restart or missed clock transition never replays an obsolete command.
   let config;try{config=validateScheduleConfig(JSON.parse(await readFile(configPath,'utf8')));}catch{await writeScheduleStatus(statusPath,{mode:'preview',status:'invalid_configuration',checkedAt:new Date().toISOString(),applied:false,hardwareWrites:0});throw Error('Configuração inválida. Worker interrompido, sem envio físico.');}
   const status=await previewSchedule(config,async rule=>inspectScheduleSource(rule,await IdSecureReader.fromFile(sourcePath)));
   await writeScheduleStatus(statusPath,status);
   const summary=JSON.stringify({ruleId:status.ruleId,desired:status.desired,status:status.status,...(status.failureKind?{failureKind:status.failureKind}:{}),applied:false,hardwareWrites:0});if(summary!==lastSummary){console.log(summary);lastSummary=summary;}
   if(args.includes('--once')){if(status.status==='source_unavailable_or_changed')process.exitCode=1;break;}
   if(status.failureKind&&!['offline','timeout'].includes(status.failureKind)){process.exitCode=1;break;}
   failures=status.failureKind?Math.min(failures+1,6):0;
   const delay=failures?Math.min(300000,config.pollSeconds*1000*2**(failures-1)*(0.8+Math.random()*0.4)):config.pollSeconds*1000;
   await new Promise(done=>{if(stopping)return done();const timer=setTimeout(done,delay);wake=()=>{clearTimeout(timer);done();};});wake=undefined;
  }while(!stopping);
 }finally{for(const signal of ['SIGINT','SIGTERM'])process.off(signal,stop);await unlock();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Automação não iniciada ou interrompida. Confira configuração, credenciais, estado e arquivo de bloqueio; nenhum comando físico é enviado por este worker.');process.exitCode=1;});
