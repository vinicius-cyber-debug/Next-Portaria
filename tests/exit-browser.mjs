import {chromium,expect as baseExpect} from '@playwright/test';
import {createRequire} from 'node:module';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {hasPostgres,withPostgresFixture,waitUntil} from './support/postgres-fixture.mjs';
import {exitFixture} from './support/exit-fixture.mjs';
import {centralFixture} from './support/idsecure-central-fixture.mjs';
import {hashPassword} from '../lib/local-auth.ts';

const expect=baseExpect.configure({timeout:30000});
if(!hasPostgres)throw Error('Configure PostgreSQL de QA para homologar liberações.');
const output=resolve('.porto-tooling/exit-review');await mkdir(output,{recursive:true});
const temporary=await mkdtemp(join(tmpdir(),'next-portaria-exit-ui-'));let browser,child,central,logs='';const screenshots=[],errors=[],violations=[];
const freePort=async()=>{const socket=createServer();await new Promise(done=>socket.listen(0,'127.0.0.1',done));const port=socket.address().port;await new Promise(done=>socket.close(done));return port;};
async function closeChild(){
 if(child&&child.exitCode===null){const exited=new Promise(done=>child.once('exit',done));if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else process.kill(-child.pid,'SIGTERM');await exited;}
 child=null;
}
try{
 central=await centralFixture(temporary);
 await withPostgresFixture(async fixture=>{
  try{
   const {owner,db,database,role,password:appPassword,adminConfig}=fixture,f=await exitFixture({db,owner});
   await f.leaders('sec_expedicao','other',null);await f.assign('employee-b','sec_expedicao');
   const password=randomBytes(24).toString('hex'),credential=await hashPassword(password);
   await owner.query('UPDATE operational_credentials SET password_hash=$1,password_salt=$2,password_iterations=$3',[credential.hash,credential.salt,credential.iterations]);
   const config=join(temporary,'server.json'),media=join(temporary,'media');await mkdir(media);
   const httpsPort=await freePort(),uiPort=await freePort(),origin='https://127.0.0.1:'+httpsPort;
   await writeFile(config,JSON.stringify({host:'127.0.0.1',subnet:'127.0.0.0/8',port:httpsPort,uiPort,cert:central.tls.cert,key:central.tls.key}));
   child=spawn(process.execPath,['--experimental-strip-types','scripts/server-process.mjs'],{windowsHide:true,detached:process.platform!=='win32',env:{...process.env,PORTO_DB_PROVIDER:'postgres',PORTO_PG_CONFIG:JSON.stringify({...adminConfig,database,user:role,password:appPassword}),PORTO_MEDIA_ROOT:media,PORTO_IDSECURE_CONFIG:join(temporary,'no-real-integration.json'),PORTO_EXIT_CONFIG:central.configFile,PORTO_SERVER_CONFIG:config,PORTO_NATIVE_PROCESS_FILE:join(temporary,'process.json')},stdio:['ignore','pipe','pipe']});
   for(const stream of [child.stdout,child.stderr])stream.on('data',value=>{logs=(logs+value).slice(-5000);});
   const ready=()=>new Promise(done=>{const request=httpsRequest(origin,{ca:central.tls.ca,timeout:2000},response=>{response.resume();done(response.statusCode===200);});request.on('error',()=>done(false));request.on('timeout',()=>request.destroy());request.end();});
   await waitUntil(ready,'HTTPS isolado não iniciou. '+logs,90000);
   browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
   const axe=createRequire(import.meta.url).resolve('axe-core/axe.min.js');
   async function session(actor){const context=await browser.newContext({ignoreHTTPSErrors:true,reducedMotion:'reduce',viewport:{width:1366,height:850}}),response=await context.request.post(origin+'/api/auth/login',{headers:{origin},data:{username:actor,password}});expect(response.status()).toBe(200);const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);await expect(page.getByRole('navigation',{name:'Navegação principal'})).toBeAttached();return{context,page};}
   async function nav(page,name){if(page.viewportSize().width<=1024){const menu=page.getByRole('button',{name:'Abrir menu',exact:true});if(await menu.getAttribute('aria-expanded')!=='true')await menu.click();}await page.getByRole('navigation',{name:'Navegação principal'}).getByRole('button',{name,exact:true}).click();}
   async function exitTab(page){await nav(page,'Central de Acesso');if(page.viewportSize().width<=1024)await page.getByLabel('Seção da central',{exact:true}).selectOption('exit-permits');else await page.getByRole('button',{name:'Liberações de saída',exact:true}).click();await expect(page.locator('.exit-access-panel')).toBeVisible();}
   async function capture(page,name){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.addScriptTag({path:axe});const result=await page.evaluate(async()=>window.axe.run(document.querySelector('[role="dialog"]')||document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}));for(const violation of result.violations)violations.push({name,id:violation.id,nodes:violation.nodes.map(node=>({html:node.html,summary:node.failureSummary}))});await page.screenshot({path:join(output,name+'.png'),animations:'disabled'});screenshots.push(name);}
   const admin=await session('admin');await nav(admin.page,'Administração');await admin.page.getByRole('button',{name:'Setores e líderes',exact:true}).click();
   await expect(admin.page.getByLabel('Setor da equipe').locator('option')).toHaveCount(24);
   await admin.page.getByLabel('Setor da equipe').selectOption('sec_ti');await admin.page.getByLabel('Líder do setor',{exact:true}).selectOption('director');await admin.page.getByLabel('Substituto',{exact:true}).selectOption('operations');await admin.page.getByRole('button',{name:'Salvar responsáveis',exact:true}).click();await expect(admin.page.getByText('Líder e substituto atualizados. Nenhuma permissão física foi alterada.',{exact:true})).toBeVisible();
   let row=admin.page.locator('.exit-person-row').filter({hasText:'Funcionário fictício employee-a'});await row.getByRole('button',{name:'Vincular setor',exact:true}).click();let dialog=admin.page.getByRole('dialog');await dialog.getByLabel('Setor do funcionário').selectOption('sec_ti');await dialog.getByRole('button',{name:'Confirmar',exact:true}).click();await expect(dialog).toHaveCount(0);
   expect(central.rules.size).toBe(0);await capture(admin.page,'setores-sem-alteracao-fisica');
   row=admin.page.locator('.exit-person-row').filter({hasText:'Funcionário fictício employee-a'});await row.getByRole('button',{name:'Preparar controle',exact:true}).click();dialog=admin.page.getByRole('dialog');await dialog.getByLabel('Justificativa').fill('Homologação isolada com central fictícia');await dialog.getByRole('button',{name:'Confirmar',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(row.getByRole('button',{name:'Confirmar homologação',exact:true})).toBeVisible();
   await row.getByRole('button',{name:'Confirmar homologação',exact:true}).click();dialog=admin.page.getByRole('dialog');for(const checkbox of await dialog.getByRole('checkbox').all())await checkbox.check();await dialog.getByLabel('Evidência da homologação').fill('Entrada normal, saída pendente e contingência simulados em QA');await dialog.getByRole('button',{name:'Confirmar',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(row.getByText('Controle de saída homologado',{exact:true})).toBeVisible();
   const leader=await session('director');await exitTab(leader.page);await expect(leader.page.locator('.exit-person-row')).toHaveCount(1);expect(await leader.page.locator('.exit-person-list').first().innerText()).not.toContain('employee-b');
   await leader.page.getByRole('button',{name:'Liberar saída por 15 minutos',exact:true}).click();dialog=leader.page.getByRole('dialog');await dialog.getByLabel('Justificativa').fill('Saída pessoal autorizada pelo líder em QA');await capture(leader.page,'autorizar-saida');await dialog.getByRole('button',{name:'Autorizar por 15 minutos',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(leader.page.locator('.exit-permit-row')).toHaveCount(1);
   const pending=central.pending();await waitUntil(async()=>central.requests.some(row=>row.path.endsWith('/reason=3/'+pending.idLog)||row.path.endsWith(',reason=3/'+pending.idLog)),'Central simulada não recebeu autorização individual',15000);
   await expect(leader.page.getByText('Autorização atendida',{exact:false})).toBeVisible();await capture(leader.page,'saída-confirmada-sem-inferir-giro');
   for(const width of [768,390,360]){await leader.page.setViewportSize({width,height:844});await capture(leader.page,'liberacao-'+width);}
   const substitute=await session('operations');await exitTab(substitute.page);await substitute.page.getByRole('button',{name:'Revogar',exact:true}).click();dialog=substitute.page.getByRole('dialog');await dialog.getByLabel('Justificativa').fill('Revogação antecipada pelo substituto em QA');await dialog.getByRole('button',{name:'Confirmar',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(substitute.page.getByText('Tecnologia da Informação (TI) · Revogada',{exact:true})).toBeVisible();
   const before=central.requests.filter(row=>row.path.includes('/action/')).length;central.pending();await waitUntil(async()=>(await owner.query("SELECT status FROM exit_worker_state WHERE id=1")).rows[0]?.status==='ready','Serviço não retomou');expect(central.requests.filter(row=>row.path.includes('/action/')).length).toBe(before);
   central.state.offline=true;await waitUntil(async()=>(await owner.query("SELECT status FROM exit_worker_state WHERE id=1")).rows[0]?.status==='unavailable','Falta de conexão não detectada',15000);await substitute.page.getByRole('button',{name:'Atualizar',exact:true}).click();await expect(substitute.page.getByText(/Serviço de saída indisponível ou em verificação/)).toBeVisible();await capture(substitute.page,'falha-conexao');
   const other=await session('other');await exitTab(other.page);await expect(other.page.locator('.exit-person-row')).toHaveCount(1);expect(await other.page.locator('.exit-person-row').innerText()).toContain('employee-b');expect((await other.context.request.post(origin+'/api/exit-access/commands',{headers:{origin},data:{type:'GRANT',payload:{personId:'employee-a',sectorId:'sec_ti',reason:'Tentativa fora de setor QA'},idempotencyKey:randomUUID()}})).status()).toBe(403);
   const gate=await session('gate');await exitTab(gate.page);await expect(gate.page.getByRole('button',{name:'Liberar saída por 15 minutos',exact:true})).toHaveCount(0);
   central.state.offline=false;
  }finally{if(browser){await browser.close();browser=null;}await closeChild();}
 });
 await writeFile(join(output,'relatorio.json'),JSON.stringify({screenshots,errors,violations},null,2));expect(errors).toEqual([]);expect(violations).toEqual([]);console.log('Liberação de saída: fluxo HTTPS, escopo, serviço autônomo e '+screenshots.length+' telas aprovados.');
}catch(error){await writeFile(join(output,'relatorio.json'),JSON.stringify({screenshots,errors,violations,error:String(error),logs},null,2));throw error;}
finally{if(browser)await browser.close();await closeChild();await central?.close();if(!resolve(temporary).startsWith(resolve(tmpdir())+sep))throw Error('Pasta QA inválida.');await rm(temporary,{recursive:true,force:true});}
