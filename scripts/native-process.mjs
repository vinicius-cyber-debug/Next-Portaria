import {readFileSync,writeFileSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {projectRoot} from './postgres-config.mjs';
export const nativeProcessPath=process.env.PORTO_NATIVE_PROCESS_FILE??join(projectRoot,'.porto-runtime/native-process.json');
export function readNativeProcess(){try{return JSON.parse(readFileSync(nativeProcessPath,'utf8'));}catch{return null;}}
export function registerNativeProcess(mode,port){
 const old=readNativeProcess();if(old?.pid&&old.pid!==process.pid){let alive=false;try{process.kill(old.pid,0);alive=true;}catch{/* stale */}if(alive)throw Error('Ja existe uma aplicacao desta copia em execucao. Use npm run stop primeiro.');}
 mkdirSync(dirname(nativeProcessPath),{recursive:true});
 writeFileSync(nativeProcessPath,JSON.stringify({pid:process.pid,root:projectRoot,mode,port,startedAt:Math.round(performance.timeOrigin)}),{mode:0o600});
 process.on('exit',()=>{if(existsSync(nativeProcessPath)&&readNativeProcess()?.pid===process.pid)rmSync(nativeProcessPath,{force:true});});
}
