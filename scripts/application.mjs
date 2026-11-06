import {spawnSync} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {loadApplicationEnvironment,projectRoot} from './postgres-config.mjs';
import {nativeProcessPath,readNativeProcess} from './native-process.mjs';
const action=process.argv[2]??'start',provider=loadApplicationEnvironment();
function invoke(script,args=[]){const r=spawnSync(process.execPath,['--experimental-strip-types',join(projectRoot,script),...args],{cwd:projectRoot,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;process.exitCode=r.status??1;}
try{
 if(provider!=='postgres')invoke('scripts/local-service.mjs',[action==='backup'?'backup':action]);
 else if(action==='start')invoke('scripts/run-framework.mjs',['start','--hostname','127.0.0.1','--port','5180']);
 else if(action==='backup')invoke('scripts/backup-postgres.mjs',['create','--offline']);
 else if(action==='status'){
  const record=readNativeProcess(),page=await fetch(`http://127.0.0.1:${record?.port??5180}/`,{signal:AbortSignal.timeout(2000)}).catch(()=>null);
  console.log(JSON.stringify({provider,status:page?.ok?'running':'stopped',port:record?.port??5180,pid:record?.pid??null}));
 }else if(action==='stop'){
  const record=readNativeProcess();if(!record){console.log('A aplicacao nao possui processo registrado.');}
  else{
   if(record.root!==projectRoot||!Number.isInteger(record.pid)||record.pid<=0)throw Error('Registro de processo invalido.');
   let alive=false;try{process.kill(record.pid,0);alive=true;}catch{/* already closed */}
   if(alive&&process.platform==='win32'){
    const check=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${record.pid}'; if($p){[PSCustomObject]@{command=$p.CommandLine;started=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress}`],{encoding:'utf8',windowsHide:true});
    const actual=check.status===0&&check.stdout.trim()?JSON.parse(check.stdout):null;
    if(!actual?.command||!['run-framework.mjs','server-process.mjs'].some(file=>actual.command.includes(file))||Math.abs(actual.started-record.startedAt)>10000)throw Error('O processo mudou. Nenhum processo desconhecido foi encerrado.');
    const stopped=spawnSync('taskkill.exe',['/PID',String(record.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});if(stopped.status!==0)throw Error('Nao foi possivel encerrar a aplicacao.');
   }else if(alive)process.kill(record.pid,'SIGTERM');
   await rm(nativeProcessPath,{force:true});console.log('Aplicacao encerrada; o PostgreSQL permanece como processo separado.');
  }
 }else throw Error('Use start, stop, status ou backup.');
}catch(error){console.error('ERRO:',error.message);process.exitCode=1;}
