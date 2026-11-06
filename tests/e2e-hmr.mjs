import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile,readFile,unlink,rmdir,mkdtemp} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve,join,sep} from 'node:path';
const root=resolve('.'),id='hmr-qa-'+randomUUID().slice(0,8),folder=join(root,'app',id),file=join(folder,'page.tsx');
if(!folder.startsWith(join(root,'app')+sep))throw Error('Pasta de ensaio fora do projeto.');
const source=label=>`'use client';\nimport {useState,useEffect} from 'react';\nexport default function HmrProbe(){const [n,setN]=useState(0),[ready,setReady]=useState(false);useEffect(()=>setReady(true),[]);return <main><p data-testid="hmr-label">${label}</p><button disabled={!ready} onClick={()=>setN(n+1)}>Contador {n}</button></main>;}\n`;
const managed=process.env.PORTO_E2E_MANAGE_SERVER==='true',origin=process.env.PORTO_E2E_URL??(managed?'http://127.0.0.1:5195':'http://127.0.0.1:5180');
const port=new URL(origin).port;let child,browser,logs='',written='';
await mkdir(join(root,'.porto-tooling'),{recursive:true});const runtime=await mkdtemp(join(root,'.porto-tooling/hmr-e2e-'));
try{
 await mkdir(folder);written=source('versao-1');await writeFile(file,written);
 if(managed){
  child=spawn(process.execPath,['scripts/run-framework.mjs','dev','--hostname','127.0.0.1','--port',port],{cwd:root,windowsHide:true,env:{...process.env,PORTO_NATIVE_PROCESS_FILE:join(runtime,'process.json')},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{logs=(logs+data).slice(-8000);});
 }
 const deadline=Date.now()+120000;
 while(true){
  if(child&&child.exitCode!==null)throw Error('Servidor de desenvolvimento encerrou antes do teste.');
  const response=await fetch(origin,{signal:AbortSignal.timeout(3000)}).catch(()=>null);
  if(response?.ok)break;
  if(Date.now()>deadline)throw Error('Servidor de desenvolvimento nao ficou disponivel.');
  await new Promise(done=>setTimeout(done,500));
 }
 browser=await chromium.launch({headless:true,...(process.env.PORTO_PLAYWRIGHT_CHANNEL?{channel:process.env.PORTO_PLAYWRIGHT_CHANNEL}:process.platform==='win32'&&existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?{channel:'msedge'}:{})});
 const page=await browser.newPage();
 page.on('pageerror',error=>{logs+='\nBrowser: '+error.message;});
 await page.goto(origin+'/'+id,{timeout:120000,waitUntil:'domcontentloaded'});
 await expect(page.getByTestId('hmr-label')).toHaveText('versao-1',{timeout:60000});
 await expect(page.getByRole('button',{name:'Contador 0',exact:true})).toBeEnabled({timeout:60000});
 await page.getByRole('button',{name:'Contador 0',exact:true}).click();
 await expect(page.getByRole('button',{name:'Contador 1',exact:true})).toBeVisible();
 written=source('versao-2');await writeFile(file,written);
 await expect(page.getByTestId('hmr-label')).toHaveText('versao-2',{timeout:60000});
 await expect(page.getByRole('button',{name:'Contador 1',exact:true})).toBeVisible();
 console.log('HMR aprovado: navegador recebeu a alteracao e preservou o estado React sem recarregar a pagina.');
}catch(error){console.error(logs);throw error;}
finally{
 if(browser)await browser.close();
 if(child&&child.exitCode===null){if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else child.kill('SIGTERM');}
 if(existsSync(file)&&await readFile(file,'utf8')===written)await unlink(file);
 if(existsSync(folder))await rmdir(folder);
}
