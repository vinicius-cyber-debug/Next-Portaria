import {chromium,expect as baseExpect} from '@playwright/test';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {hasPostgres,withPostgresFixture} from './support/postgres-fixture.mjs';
import {hashPassword} from '../lib/local-auth.ts';
import {handleApi} from '../lib/server.ts';
const expect=baseExpect.configure({timeout:30000});

if(!hasPostgres)throw Error('Configure PostgreSQL de QA para executar o teste do Porto.');
const output=resolve(process.env.PORTO_PORTO_TEST_OUTPUT||'.porto-tooling/porto-review');await mkdir(output,{recursive:true});
const temporary=await mkdtemp(join(tmpdir(),'portaria-porto-qa-'));let browser,child,logs='';const screenshots=[],errors=[],violations=[];
const port=async()=>{const socket=createServer();await new Promise(done=>socket.listen(0,'127.0.0.1',done));const value=socket.address().port;await new Promise(done=>socket.close(done));return value};
try{
 await withPostgresFixture(async({owner,db,database,role,password:appPassword,adminConfig})=>{
  try{
  await handleApi(new Request('http://127.0.0.1/api/session'),db);
  const password=randomBytes(24).toString('hex'),credential=await hashPassword(password),now=new Date().toISOString();
  for(const actor of ['admin','director','gate','finance']){
   await owner.query("INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES($1,$2,$3,$1,'active',$4,$4)",[actor,actor+'@example.test',actor+' QA',now]);
   await owner.query('INSERT INTO operational_credentials(user_id,username,password_hash,password_salt,password_iterations,password_changed_at,must_change_password) VALUES($1,$2,$3,$4,$5,$6,0)',[actor,'porto.'+actor,credential.hash,credential.salt,credential.iterations,now]);
  }
  for(const [collection,id,record] of [['fleet','vehicle-qa',{plate:'QAT1A23',driver:'Motorista fictício QA',active:true}],['people','person-qa',{name:'Motorista fictício QA',category:'driver',active:true,securityStatus:'cleared'}],['companies','company-qa',{name:'Empresa fictícia QA',active:true}]])await owner.query('INSERT INTO operational_records(collection,id,body) VALUES($1,$2,$3)',[collection,id,JSON.stringify({id,...record,createdAt:now,updatedAt:now,createdBy:'admin'})]);
  const cert=join(temporary,'cert.pem'),key=join(temporary,'cert.key'),config=join(temporary,'server.json'),media=join(temporary,'media');await mkdir(media);
  const generated=spawnSync(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{windowsHide:true,encoding:'utf8'});if(generated.status!==0)throw Error('Certificado temporário QA indisponível.');
  const httpsPort=await port(),uiPort=await port(),origin='https://127.0.0.1:'+httpsPort;
  await writeFile(config,JSON.stringify({host:'127.0.0.1',subnet:'127.0.0.0/8',port:httpsPort,uiPort,cert,key}));
  child=spawn(process.execPath,['--experimental-strip-types','scripts/server-process.mjs'],{windowsHide:true,detached:process.platform!=='win32',env:{...process.env,PORTO_DB_PROVIDER:'postgres',PORTO_PG_CONFIG:JSON.stringify({...adminConfig,database,user:role,password:appPassword}),PORTO_MEDIA_ROOT:media,PORTO_PORTO_ENABLED:'true',PORTO_SERVER_CONFIG:config,PORTO_NATIVE_PROCESS_FILE:join(temporary,'process.json')},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',value=>{logs=(logs+value).slice(-6000)});
  const ca=await readFile(cert),ready=()=>new Promise(done=>{const call=httpsRequest(origin,{ca,timeout:2000},response=>{response.resume();done(response.statusCode===200)});call.on('error',()=>done(false));call.on('timeout',()=>call.destroy());call.end()});
  const deadline=Date.now()+90000;while(!await ready()){if(Date.now()>deadline||child.exitCode!==null)throw Error('HTTPS QA não iniciou. '+logs);await new Promise(done=>setTimeout(done,350))}
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
  const axe=createRequire(import.meta.url).resolve('axe-core/axe.min.js');
  async function session(actor,width=1366){
   const context=await browser.newContext({ignoreHTTPSErrors:true,reducedMotion:'reduce',viewport:{width,height:width<=540?844:768}});
   const response=await context.request.post(origin+'/api/auth/login',{headers:{origin},data:{username:'porto.'+actor,password}});expect(response.status()).toBe(200);
   const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
   if(actor==='gate')page.on('response',async response=>{if(response.url().includes('/api/porto/')&&response.headers()['content-type']?.includes('json')){const value=await response.json().catch(()=>null);if(/centavos/i.test(JSON.stringify(value)))errors.push('Valor financeiro exposto na sessão da portaria.')}});
   await page.goto(origin);await expect(page.getByRole('navigation',{name:'Navegação principal'})).toBeAttached();
   await navigate(page);return {page,context};
  }
  async function navigate(page){await expect(page.getByRole('navigation',{name:'Navegação principal'})).toBeAttached();if(page.viewportSize().width<=900){const menu=page.getByRole('button',{name:'Abrir menu',exact:true});await expect(menu).toBeVisible();if(await menu.getAttribute('aria-expanded')!=='true')await menu.click()}await page.getByRole('navigation',{name:'Navegação principal'}).getByRole('button',{name:'Gestão do Porto',exact:true}).click();await expect(page.locator('.porto-clock')).toBeVisible()}
  async function capture(page,label){
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.addScriptTag({path:axe});const result=await page.evaluate(async()=>window.axe.run(document.querySelector('[role="dialog"]')||document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}));
   for(const violation of result.violations)violations.push({label,id:violation.id,nodes:violation.nodes.map(node=>({html:node.html,summary:node.failureSummary}))});
   await page.screenshot({path:join(output,label+'.png'),animations:'disabled',timeout:45000});screenshots.push(label);console.log('Porto UI '+label);
  }
  const admin=await session('admin');await expect(admin.page.getByRole('button',{name:'Solicitar descida',exact:true})).toBeDisabled();await capture(admin.page,'porto-sem-tarifas');
  await admin.page.getByRole('button',{name:'Nova tabela tarifária',exact:true}).click();let photo=admin.page.getByRole('dialog');await photo.getByRole('button',{name:'Preencher com a tabela da foto',exact:true}).click();await expect(photo.locator('fieldset')).toHaveCount(10);await expect(photo.getByRole('textbox',{name:'Tarifa em reais 1',exact:true})).toHaveValue('25,00');await expect(photo.getByRole('textbox',{name:'Tarifa em reais 10',exact:true})).toHaveValue('1000,00');await capture(admin.page,'porto-tarifas-foto');await photo.getByRole('button',{name:'Cancelar',exact:true}).click();expect((await owner.query('SELECT count(*) AS n FROM porto_tabelas_tarifarias')).rows[0].n).toBe('0');photo=null;
  async function publish(price){
   await admin.page.getByRole('button',{name:'Nova tabela tarifária',exact:true}).click();const dialog=admin.page.getByRole('dialog');
   await dialog.getByRole('textbox',{name:'Nome da tabela',exact:true}).fill('Tarifas fictícias QA');await dialog.getByRole('textbox',{name:'Código da categoria 1',exact:true}).fill('carro');await dialog.getByRole('textbox',{name:'Nome da categoria 1',exact:true}).fill('Carro QA');await dialog.getByRole('textbox',{name:'Tarifa em reais 1',exact:true}).fill(price);await dialog.getByRole('textbox',{name:'Justificativa da publicação',exact:true}).fill('Somente testes em base descartável');await capture(admin.page,'porto-publicar-'+price.replace(',','-'));
   await dialog.getByRole('button',{name:'Publicar tabela',exact:true}).click();await expect(admin.page.getByRole('dialog')).toHaveCount(0);await expect(admin.page.getByRole('button',{name:'Solicitar descida',exact:true})).toBeEnabled();
  }
  await publish('150,00');
  const gate=await session('gate',390);await gate.page.getByRole('button',{name:'Solicitar descida',exact:true}).click();let dialog=gate.page.getByRole('dialog');
  await expect(dialog.getByRole('combobox',{name:'Veículo cadastrado',exact:true}).locator('option[value="vehicle-qa"]')).toHaveCount(1);await dialog.getByRole('combobox',{name:'Veículo cadastrado',exact:true}).selectOption('vehicle-qa');await dialog.getByRole('combobox',{name:'Motorista cadastrado (opcional)',exact:true}).selectOption('person-qa');await dialog.getByRole('combobox',{name:'Categoria tarifária',exact:true}).selectOption('carro');await capture(gate.page,'porto-solicitar-390');
  await dialog.getByRole('button',{name:'Próximo',exact:true}).click();await dialog.getByRole('textbox',{name:'Embarcação de destino',exact:true}).fill('Embarcação fictícia QA');await dialog.getByRole('textbox',{name:'Finalidade da descida',exact:true}).fill('Validar a solicitação de descida');await dialog.getByRole('button',{name:'Enviar solicitação',exact:true}).click();await expect(gate.page.getByRole('dialog')).toHaveCount(0);await expect(gate.page.getByRole('button',{name:'Aprovar',exact:true})).toHaveCount(0);await capture(gate.page,'porto-pendente-390');
  const director=await session('director');await director.page.getByRole('button',{name:'Aprovar',exact:true}).click();dialog=director.page.getByRole('dialog');await dialog.getByRole('textbox',{name:'Justificativa da decisão',exact:true}).fill('Aprovação de homologação');await dialog.getByRole('button',{name:'Confirmar',exact:true}).click();await expect(director.page.getByRole('dialog')).toHaveCount(0);
  await gate.page.reload();await navigate(gate.page);await gate.page.getByRole('button',{name:'Registrar entrada',exact:true}).click();dialog=gate.page.getByRole('dialog');await dialog.getByRole('button',{name:'Confirmar',exact:true}).click();await expect(dialog).toBeVisible();await dialog.getByRole('checkbox').check();await capture(gate.page,'porto-conferir-entrada-390');await dialog.getByRole('button',{name:'Confirmar',exact:true}).click();await expect(gate.page.getByRole('dialog')).toHaveCount(0);
  await publish('300,00');await admin.page.getByRole('button',{name:'Veículos no porto',exact:true}).click();await expect(admin.page.getByRole('row').filter({hasText:'QAT1A23'})).toContainText('150,00');
  for(const width of [1920,1366,768,430,390,360]){await admin.page.setViewportSize({width,height:width<=540?844:width===1920?1080:768});await capture(admin.page,'porto-permanencia-'+width)}
  await gate.page.getByRole('button',{name:'Veículos no porto',exact:true}).click();await expect(gate.page.getByRole('columnheader',{name:'Tarifa fixada',exact:true})).toHaveCount(0);await capture(gate.page,'porto-portaria-sem-valores');
  const finance=await session('finance');await expect(finance.page.getByRole('button',{name:'Solicitar descida',exact:true})).toHaveCount(0);await expect(finance.page.getByRole('button',{name:'Nova tabela tarifária',exact:true})).toHaveCount(0);await finance.page.getByRole('button',{name:'Veículos no porto',exact:true}).click();await expect(finance.page.getByRole('row').filter({hasText:'QAT1A23'})).toContainText('150,00');await capture(finance.page,'porto-financeiro-consulta');
  await admin.page.setViewportSize({width:1366,height:768});await admin.page.getByRole('button',{name:'Histórico',exact:true}).click();await capture(admin.page,'porto-historico');
  let releaseSlow,arrivedSlow=false,finishedSlow=false;
  const released=new Promise(done=>{releaseSlow=done});
  await admin.page.route('**/api/porto/permanencias?**',async route=>{const response=await route.fetch();arrivedSlow=true;await released;await route.fulfill({response});finishedSlow=true},{times:1});
  try{
   await admin.page.getByRole('button',{name:'Veículos no porto',exact:true}).click();await expect.poll(()=>arrivedSlow,{timeout:30000}).toBe(true);
   await admin.page.getByRole('button',{name:'Solicitações',exact:true}).click();await expect(admin.page.getByRole('row').filter({hasText:'QAT1A23'})).toContainText('Entrada registrada');
  }finally{releaseSlow()}
  await expect.poll(()=>finishedSlow,{timeout:30000}).toBe(true);await expect(admin.page.getByRole('row').filter({hasText:'QAT1A23'})).toContainText('Entrada registrada');
  console.log('Porto: resposta lenta descartada após trocar de aba.');
  await finance.page.getByRole('button',{name:'Financeiro',exact:true}).click();await expect(finance.page.getByRole('button',{name:'Abrir conta · QAT1A23',exact:true})).toBeVisible();await capture(finance.page,'porto-financeiro-contas');
  async function openAccount(){await finance.page.getByRole('button',{name:'Abrir conta · QAT1A23',exact:true}).click();await expect(finance.page.getByRole('dialog').getByText('Empresa pagadora ainda não identificada',{exact:false})).toHaveCount(1)}
  await openAccount();await finance.page.getByRole('dialog').getByRole('button',{name:'Identificar empresa',exact:true}).click();dialog=finance.page.getByRole('dialog');await expect(dialog.getByRole('combobox',{name:'Empresa pagadora',exact:true}).locator('option[value="company-qa"]')).toHaveCount(1);await dialog.getByRole('combobox',{name:'Empresa pagadora',exact:true}).selectOption('company-qa');await dialog.getByRole('textbox',{name:'Justificativa',exact:true}).fill('Empresa pagadora da homologação');await dialog.getByRole('button',{name:'Confirmar operação',exact:true}).click();await expect(finance.page.getByRole('dialog')).toHaveCount(0);
  await finance.page.getByRole('button',{name:'Abrir conta · QAT1A23',exact:true}).click();dialog=finance.page.getByRole('dialog');await expect(dialog.getByText('Empresa fictícia QA',{exact:false})).toBeVisible();await dialog.getByRole('button',{name:'Registrar adiantamento',exact:true}).click();dialog=finance.page.getByRole('dialog');await dialog.getByRole('textbox',{name:'Valor em reais',exact:true}).fill('100,00');await dialog.getByRole('combobox',{name:'Forma de recebimento',exact:true}).selectOption('pix');await dialog.getByRole('textbox',{name:'Referência do recebimento',exact:true}).fill('QA-PIX-100');await dialog.getByRole('textbox',{name:'Justificativa',exact:true}).fill('Adiantamento de homologação');await capture(finance.page,'porto-adiantamento');await dialog.getByRole('button',{name:'Confirmar operação',exact:true}).click();await expect(finance.page.getByRole('dialog')).toHaveCount(0);
  await director.page.getByRole('button',{name:'Financeiro',exact:true}).click();await director.page.getByRole('button',{name:'Abrir conta · QAT1A23',exact:true}).click();dialog=director.page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'Autorizar desconto',exact:true})).toBeEnabled();await dialog.getByRole('button',{name:'Autorizar desconto',exact:true}).click();dialog=director.page.getByRole('dialog');await dialog.getByRole('textbox',{name:'Valor em reais',exact:true}).fill('50,00');await dialog.getByRole('textbox',{name:'Justificativa',exact:true}).fill('Desconto autorizado em QA para fechar o saldo');await dialog.getByRole('button',{name:'Confirmar operação',exact:true}).click();await expect(director.page.getByRole('dialog')).toHaveCount(0);
  await gate.page.reload();await navigate(gate.page);await gate.page.getByRole('button',{name:'Veículos no porto',exact:true}).click();await expect(gate.page.getByRole('button',{name:'Registrar saída',exact:true})).toBeEnabled();await gate.page.getByRole('button',{name:'Registrar saída',exact:true}).click();dialog=gate.page.getByRole('dialog');await dialog.getByRole('checkbox').check();await capture(gate.page,'porto-saida-quitada-390');await dialog.getByRole('button',{name:'Confirmar',exact:true}).click();await expect(gate.page.getByRole('dialog')).toHaveCount(0);await expect(gate.page.getByText('Saída registrada',{exact:true})).toHaveCount(0);
  await finance.page.getByRole('button',{name:'Atualizar',exact:true}).click();await finance.page.getByRole('button',{name:'Abrir conta · QAT1A23',exact:true}).click();dialog=finance.page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'Ver cobrança',exact:true})).toBeVisible();await dialog.getByRole('button',{name:/^Recibo /}).first().click();await expect(finance.page.getByRole('dialog').getByText('Documento de controle interno · não fiscal',{exact:true})).toBeVisible();await capture(finance.page,'porto-recibo');await finance.page.emulateMedia({media:'print'});await expect(finance.page.locator('.app-shell')).toBeHidden();await expect(finance.page.locator('.porto-financial-document')).toBeVisible();await capture(finance.page,'porto-recibo-impressao');await finance.page.emulateMedia({media:'screen'});await finance.page.getByRole('dialog').getByRole('button',{name:'Fechar',exact:true}).last().click();
  for(const width of [1366,768,390,360]){await finance.page.setViewportSize({width,height:width<=540?844:768});await capture(finance.page,'porto-contas-'+width)}
  await finance.page.setViewportSize({width:1366,height:768});await finance.page.getByRole('button',{name:'Indicadores do Porto',exact:true}).click();await expect(finance.page.getByText('Recebido por categoria',{exact:true})).toBeVisible();await capture(finance.page,'porto-indicadores');await finance.page.getByRole('button',{name:'Exportar CSV',exact:true}).click();
  await finance.page.getByRole('button',{name:'Caixa',exact:true}).click();await expect(finance.page.getByRole('button',{name:'Conferir e fechar lote',exact:true})).toBeEnabled();await finance.page.getByRole('button',{name:'Conferir e fechar lote',exact:true}).click();dialog=finance.page.getByRole('dialog');await dialog.getByRole('textbox',{name:'Saldo inicial em dinheiro (R$)',exact:true}).fill('0,00');await dialog.getByRole('textbox',{name:'Dinheiro conferido ao fechar (R$)',exact:true}).fill('0,00');await dialog.getByRole('textbox',{name:'Justificativa',exact:true}).fill('Conferência do lote de QA');await dialog.getByRole('button',{name:'Confirmar operação',exact:true}).click();await expect(finance.page.getByRole('dialog')).toHaveCount(0);await expect(finance.page.getByRole('button',{name:'Conferir e fechar lote',exact:true})).toBeDisabled();await capture(finance.page,'porto-caixa-fechado');
  expect((await owner.query('SELECT count(*) AS n FROM porto_cobrancas')).rows[0].n).toBe('1');
  expect((await owner.query('SELECT count(*) AS n FROM porto_permanencias')).rows[0].n).toBe('1');expect((await owner.query("SELECT count(*) AS n FROM operational_records WHERE collection IN ('visitors','vehicles','stays','charges')")).rows[0].n).toBe('0');
  }finally{
   if(browser){await browser.close();browser=null}
   if(child&&child.exitCode===null){if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else process.kill(-child.pid,'SIGTERM');await new Promise(done=>child.once('exit',done))}
  }
 });
 await writeFile(join(output,'relatorio.json'),JSON.stringify({screenshots,errors,violations},null,2));expect(errors).toEqual([]);expect(violations).toEqual([]);console.log('Porto: fluxo no HTTPS e '+screenshots.length+' capturas aprovadas.');
}catch(error){console.error(logs);await writeFile(join(output,'relatorio.json'),JSON.stringify({screenshots,errors,violations,error:String(error)},null,2));throw error}
finally{
 if(browser)await browser.close();
 if(child&&child.exitCode===null){if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else process.kill(-child.pid,'SIGTERM')}
 if(!resolve(temporary).startsWith(resolve(tmpdir())+sep))throw Error('Diretório QA fora da pasta temporária.');
 await rm(temporary,{recursive:true,force:true});
}
