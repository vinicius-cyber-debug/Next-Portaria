import {chromium,expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';

// The demo renders the real React components against a closed, memory-only API.
// This check never starts PostgreSQL, imports credentials or writes operational data.
const root=resolve('.'),output=resolve(process.env.PORTO_UI_OUTPUT||'.porto-tooling/ui-review');
const managed=process.env.PORTO_UI_MANAGE_SERVER!=='false';
const origin=process.env.PORTO_UI_URL||'http://127.0.0.1:4173';
const entry=managed?origin+'/Next-Portaria/':origin;
if(new URL(origin).hostname!=='127.0.0.1')throw Error('A revisão visual exige a demonstração em loopback.');
await mkdir(output,{recursive:true});
let server,browser,auditPage,logs='';const results=[],violations=[],errors=[];
try{
 if(managed){
  const build=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build','--config','demo/vite.config.ts'],{cwd:root,windowsHide:true,encoding:'utf8',timeout:120000});
  if(build.status!==0)throw Error('Build da demonstração falhou: '+(build.stderr||build.stdout||build.error));
  server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--config','demo/vite.config.ts','--host','127.0.0.1','--port',new URL(origin).port||'4173','--strictPort'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});for(const stream of [server.stdout,server.stderr])stream.on('data',data=>{logs=(logs+data).slice(-12000)})
 }
 const deadline=Date.now()+60000;
 while(!await fetch(entry).then(r=>r.ok).catch(()=>false)){if(server?.exitCode!==null&&server?.exitCode!==undefined)throw Error(logs);if(Date.now()>deadline)throw Error('Demonstração indisponível: '+logs);await new Promise(r=>setTimeout(r,300))}
 browser=await chromium.launch({headless:true,...(process.env.PORTO_PLAYWRIGHT_CHANNEL?{channel:process.env.PORTO_PLAYWRIGHT_CHANNEL}:process.platform==='win32'&&existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?{channel:'msedge'}:{})});
 const context=await browser.newContext({reducedMotion:'reduce'}),page=await context.newPage();
 auditPage=page;
 await context.route('**/api/**',async route=>{errors.push('API de rede bloqueada na revisão visual.');await route.abort()});
 page.setDefaultTimeout(30000);
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',request=>{if(new URL(request.url()).origin!==new URL(origin).origin)errors.push('Requisição externa inesperada: '+request.url())});
 const axePath=createRequire(import.meta.url).resolve('axe-core/axe.min.js');
 async function openModule(name){
  if(await page.getByRole('button',{name:'Abrir menu',exact:true}).isVisible())await page.getByRole('button',{name:'Abrir menu',exact:true}).click();
  await page.getByRole('navigation',{name:'Navegação principal'}).getByRole('button',{name,exact:true}).click();
  await expect(page.locator('main h1')).toContainText(name);
  await page.waitForTimeout(280); // existing debounced API pagination
 }
 async function check(label,{a11y=true,capture=true}={}){
  await page.evaluate(()=>document.fonts.ready);
  const dimensions=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
  expect(dimensions.scroll,label+' overflow').toBeLessThanOrEqual(dimensions.viewport+1);
  const dialog=page.getByRole('dialog');
  if(await dialog.count()){
   const box=await dialog.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(dimensions.viewport+1);
   expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
   const actions=dialog.locator('.modal-footer button');
   for(let index=0;index<await actions.count();index++){
    const action=actions.nth(index);if(!await action.isVisible())continue;
    expect(await action.evaluate(element=>{const box=element.getBoundingClientRect(),top=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return top===element||element.contains(top)}),label+' botão do formulário encoberto').toBe(true);
   }
  }
  if(a11y){
   await page.addScriptTag({path:axePath});
   const report=await page.evaluate(async()=>window.axe.run(document.querySelector('[role="dialog"]')||document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}));
   for(const item of report.violations)violations.push({label,id:item.id,impact:item.impact,description:item.description,nodes:item.nodes.map(n=>({html:n.html,target:n.target,summary:n.failureSummary}))});
  }
  if(capture)await page.screenshot({path:join(output,label+'.png'),fullPage:false,animations:'disabled',timeout:45000});
  results.push(label);console.log('UI '+label);
 }
 async function refinedCentral(width){
  await expect(page.locator('.access-overview')).toBeVisible();
  await expect(page.getByLabel('Setor de destino',{exact:true})).toHaveCount(0);
  if(width<=540){const box=await page.locator('.access-kpis').boundingBox();expect(box.height).toBeLessThanOrEqual(220)}
  if(width===1366){const box=await page.locator('.access-overview').boundingBox();expect(box.y).toBeLessThan(768)}
  await page.getByRole('button',{name:/Registrar saída de/}).first().click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');
  const toggle=page.getByRole('button',{name:/^Filtros/});await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded','true');
  const sector=page.getByLabel('Setor de destino',{exact:true}),value=await sector.locator('option').nth(1).getAttribute('value');
  await sector.selectOption(value);await expect(page.locator('.access-results')).toBeVisible();await expect(page.locator('.access-overview')).toHaveCount(0);
  await check(width+'-filtros-expandidos');
  await toggle.click();await expect(sector).toHaveCount(0);
  await toggle.click();await expect(sector).toHaveValue(value);
  await page.getByRole('button',{name:'Visão da operação',exact:true}).click();
  await expect(toggle).toHaveAttribute('aria-expanded','false');
  const search=page.getByRole('textbox',{name:'Consultar pessoa, documento, placa ou QR Code',exact:true});
  await search.fill('Elisa');await expect(page.locator('.access-results')).toBeVisible();
  await expect(page.locator('.access-results')).toContainText('Elisa Ramos');
  await page.getByRole('button',{name:'Limpar consulta',exact:true}).click();await expect(page.locator('.access-overview')).toBeVisible();
 }
 async function visitorSteps(width){
  const pending=Number(await page.locator('.access-kpis .stat-card').nth(1).locator('.stat-value').innerText());
  await page.getByRole('button',{name:'Novo acesso',exact:true}).click();
  const dialog=page.getByRole('dialog'),navigation=dialog.getByRole('navigation',{name:'Etapas do cadastro'}),current=navigation.locator('[aria-current="step"]');
  const name=dialog.getByRole('textbox',{name:/^Nome completo/}),company=dialog.getByRole('combobox',{name:/^Empresa \/ origem/});
  await dialog.getByRole('button',{name:'Próximo',exact:true}).click();await expect(current).toContainText('Pessoa');await expect(name).toBeFocused();
  await name.fill('Ensaio de etapas '+width);await name.press('Enter');await expect(current).toContainText('Pessoa');await expect(company).toBeFocused();
  await company.fill('Empresa fictícia de ensaio');await dialog.getByRole('button',{name:'Próximo',exact:true}).click();await expect(current).toContainText('Acesso');
  await dialog.getByRole('button',{name:'Voltar',exact:true}).click();await expect(name).toHaveValue('Ensaio de etapas '+width);await expect(company).toHaveValue('Empresa fictícia de ensaio');
  await dialog.getByRole('button',{name:'Próximo',exact:true}).click();
  await dialog.getByRole('combobox',{name:/^Setor de destino/}).selectOption({index:1});
  await dialog.getByRole('textbox',{name:/^Responsável \/ contato/}).fill('Marina Rocha');
  await check(width+'-visita-etapa-acesso');
  await dialog.getByRole('button',{name:'Próximo',exact:true}).click();await expect(current).toContainText('Visita');
  await dialog.getByRole('button',{name:'Enviar para autorização',exact:true}).click();await expect(current).toContainText('Visita');
  const purpose=dialog.getByRole('textbox',{name:/^Motivo da visita/});await expect(purpose).toBeFocused();await purpose.fill('Teste do cadastro em etapas');
  await dialog.getByText('Observações opcionais',{exact:true}).click();await dialog.getByRole('textbox',{name:'Observações',exact:true}).fill('Valores preservados ao voltar entre etapas.');
  await navigation.locator('button').nth(0).click();await name.fill('');await navigation.locator('button').nth(2).click();
  await expect(current).toContainText('Pessoa');await expect(name).toBeFocused();
  await name.fill('Ensaio de etapas '+width);await navigation.locator('button').nth(2).click();await expect(current).toContainText('Visita');
  await expect(purpose).toHaveValue('Teste do cadastro em etapas');await expect(dialog.getByRole('textbox',{name:'Observações',exact:true})).toHaveValue('Valores preservados ao voltar entre etapas.');
  await check(width+'-visita-etapa-final');
  await dialog.getByRole('button',{name:'Enviar para autorização',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.access-kpis .stat-card').nth(1).locator('.stat-value')).toHaveText(String(pending+1));
  await page.goto(entry);await expect(page.locator('main h1')).toContainText('Visão geral');await openModule('Central de Acesso');
 }
 async function vehicleSteps(width){
  const dialog=page.getByRole('dialog'),navigation=dialog.getByRole('navigation',{name:'Etapas do cadastro'});
  await dialog.getByRole('button',{name:'Próximo',exact:true}).click();await expect(navigation.locator('[aria-current="step"]')).toContainText('Veículo');
  await dialog.getByRole('textbox',{name:/^Placa/}).fill('QAT1A23');await dialog.getByRole('textbox',{name:/^Motorista/}).fill('Condutor fictício');await dialog.getByRole('combobox',{name:/^Empresa \/ origem/}).fill('Empresa fictícia');
  await dialog.getByRole('button',{name:'Próximo',exact:true}).click();await expect(dialog.getByText('Acompanhantes cadastrados',{exact:true})).toBeVisible();
  await dialog.getByLabel('Elisa Ramos',{exact:true}).check();await check(width+'-veiculo-etapa-acesso');
  await dialog.getByRole('button',{name:'Próximo',exact:true}).click();await expect(dialog.getByRole('textbox',{name:/^Motivo da entrada/})).toBeVisible();await check(width+'-veiculo-etapa-operacao');
  await dialog.getByRole('button',{name:'Voltar',exact:true}).click();await expect(dialog.getByLabel('Elisa Ramos',{exact:true})).toBeChecked();
  await dialog.getByRole('button',{name:'Voltar',exact:true}).click();await expect(dialog.getByRole('textbox',{name:/^Placa/})).toHaveValue('QAT1A23');
 }
 async function companySteps(width){
  const dialog=page.getByRole('dialog'),next=dialog.getByRole('button',{name:'Próximo',exact:true}),name=dialog.getByRole('textbox',{name:/^Nome/});
  await next.click();await expect(name).toBeFocused();await name.fill('Empresa visual '+width);await next.click();
  const email=dialog.getByRole('textbox',{name:'E-mail de contato',exact:true});await email.fill('email-invalido');
  await dialog.getByRole('button',{name:'Salvar registro',exact:true}).click();await expect(email).toBeFocused();
  await email.fill('cadastro@example.test');await dialog.getByRole('textbox',{name:'Telefone',exact:true}).fill('92999990000');
  await dialog.getByRole('button',{name:'Voltar',exact:true}).click();await expect(name).toHaveValue('Empresa visual '+width);await next.click();await expect(email).toHaveValue('cadastro@example.test');
  await check(width+'-cadastro-empresa-contato');await dialog.getByRole('button',{name:'Salvar registro',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('main')).toContainText('Empresa visual '+width);
  await page.locator('main .tabs').getByRole('button',{name:/Pessoas/}).click();await page.getByRole('button',{name:'Novo cadastro',exact:true}).click();
  await page.getByRole('dialog').getByRole('textbox',{name:/^Nome completo/}).fill('Pessoa fictícia');await page.getByRole('dialog').getByRole('button',{name:'Próximo',exact:true}).click();
  await expect(page.getByRole('dialog').getByText('Permissões específicas de área',{exact:true})).toBeVisible();await check(width+'-cadastro-pessoa-seguranca');await page.keyboard.press('Escape');
 }
 const widths=process.env.PORTO_UI_WIDTHS?process.env.PORTO_UI_WIDTHS.split(',').map(Number):[1920,1366,768,430,390,360];
 if(widths.some(width=>![1920,1366,768,430,390,360].includes(width)))throw Error('Largura de revisão inválida.');
 for(const width of widths){
  await page.setViewportSize({width,height:width>=1366?width===1920?1080:768:width===768?1024:844});
  await page.goto(entry);await expect(page.getByRole('complementary',{name:'Ambiente de demonstração'})).toBeVisible();await expect(page.locator('main h1')).toContainText('Visão geral');
  for(const pageName of ['Visão geral','Central de Acesso','Visitantes','Veículos','Ocorrências e turnos','Notificações','Cadastros','Relatórios','Auditoria','Administração']){
   await openModule(pageName);
   await check(width+'-'+pageName.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replaceAll(' ','-'),{a11y:width===1366||width===390,capture:true});
   if(pageName==='Central de Acesso'&&(width===1366||width===390))await refinedCentral(width);
   if(pageName==='Veículos'&&(width===1366||width===390)){
    await page.getByLabel('Entrada desde',{exact:true}).fill('2099-01-01');
    await expect(page.locator('main .data-table tbody tr')).toHaveCount(0);
    await page.getByRole('button',{name:'Limpar período',exact:true}).click();
    await expect(page.locator('main .data-table tbody tr').first()).toBeVisible();
   }
  }
  if(width===1366||width===390){
   for(const settings of ['Usuários e permissões','Backup e contingência','Continuidade','Permissões detalhadas','Setores e áreas de acesso']){
    await page.getByRole('navigation',{name:'Configurações'}).getByRole('button',{name:settings,exact:true}).click();await page.waitForTimeout(280);
    await check(width+'-config-'+settings.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replaceAll(' ','-'));
   }
   await openModule('Cadastros');
   for(const name of ['Veículos','Empresas']){await page.locator('main .tabs').getByRole('button',{name:new RegExp(name)}).click();await check(width+'-cadastros-'+name)}
   await page.getByRole('button',{name:'Novo cadastro',exact:true}).click();await check(width+'-cadastro-empresa');await companySteps(width);
   await openModule('Ocorrências e turnos');
   await page.getByRole('button',{name:'Nova ocorrência',exact:true}).click();await check(width+'-nova-ocorrencia');await page.keyboard.press('Escape');
   await page.getByRole('button',{name:'Passagem de turno',exact:true}).click();await check(width+'-passagem-turno');
   await page.getByRole('button',{name:'Abrir minha senha',exact:true}).click();await check(width+'-minha-senha');
   await openModule('Relatórios');
   await page.getByRole('button',{name:'Imprimir',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();
   await page.evaluate(()=>document.body.classList.add('print-mode'));
   try{
    await page.emulateMedia({media:'print'});
    await page.evaluate(()=>window.scrollTo(0,0));
    await expect(page.getByRole('dialog')).toBeVisible();await expect(page.locator('.print-target .data-table')).toBeVisible();
    await expect(page.locator('.app-shell')).toBeHidden();
    await expect(page.locator('.print-document-header')).toBeInViewport();
    await page.screenshot({path:join(output,width+'-impressao-relatorio.png'),fullPage:false,timeout:45000});
    results.push(width+'-impressao-relatorio');console.log('UI '+width+'-impressao-relatorio');
   }finally{await page.emulateMedia({media:'screen'});await page.evaluate(()=>document.body.classList.remove('print-mode'))}
   await page.keyboard.press('Escape');
  }
  await openModule('Central de Acesso');
  await page.getByRole('button',{name:'Novo acesso',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();await check(width+'-novo-acesso',{a11y:width===1366||width===390});
  await page.getByRole('textbox',{name:/^Nome completo/}).fill('Pessoa de ensaio visual');
  // Keyboard wrap and Escape restore focus; values survive scrolling within the form.
  await page.getByRole('dialog').getByRole('button',{name:'Fechar',exact:true}).focus();
  await page.keyboard.press('Shift+Tab');expect(await page.getByRole('dialog').evaluate(e=>e.contains(document.activeElement))).toBe(true);
  await expect(page.getByRole('textbox',{name:/^Nome completo/})).toHaveValue('Pessoa de ensaio visual');
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Novo acesso',exact:true})).toBeFocused();
  if(width===1366||width===390)await visitorSteps(width);
  await page.getByRole('button',{name:'Registrar veículo',exact:true}).click();await check(width+'-entrada-veiculo',{a11y:width===1366||width===390});if(width===1366||width===390)await vehicleSteps(width);await page.keyboard.press('Escape');
  for(const tab of ['Emergência','Indicadores','Ler QR Code','Segurança e validade']){
   await page.getByRole('button',{name:tab,exact:true}).click();
   await check(width+'-'+tab.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replaceAll(' ','-'),{a11y:width===1366||width===390});
  }
  await page.getByRole('button',{name:'Operação',exact:true}).click();
  await page.getByRole('button',{name:/Aguardando aprovação.*Solicitações pendentes/}).click();
  await expect(page.getByLabel('Lista',{exact:true})).toHaveValue('pending');
  const authorize=page.locator('main').getByRole('button',{name:'Autorizar',exact:true});
  if(width>=768){await authorize.first().click();await expect(page.getByRole('dialog')).toBeVisible();await check(width+'-confirmar-autorizacao',{a11y:width===1366});
   if(width===1366){await page.getByRole('dialog').getByRole('button',{name:'Confirmar',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'Registro salvo com sucesso.'})).toBeVisible()}
   else await page.keyboard.press('Escape');
  }
  if(width<=900){
   await page.getByRole('button',{name:'Abrir menu',exact:true}).click();await expect(page.getByRole('dialog',{name:'Menu da unidade'})).toBeVisible();
   await page.getByRole('button',{name:'Fechar menu',exact:true}).focus();await page.keyboard.press('Shift+Tab');expect(await page.getByRole('dialog',{name:'Menu da unidade'}).evaluate(e=>e.contains(document.activeElement))).toBe(true);
   await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Abrir menu',exact:true})).toBeFocused();
  }else{
   await page.getByRole('button',{name:'Recolher menu',exact:true}).click();await expect(page.locator('.sidebar')).toHaveCSS('width','68px');
   await page.getByRole('navigation',{name:'Navegação principal'}).getByRole('button',{name:'Relatórios',exact:true}).click();
   await check(width+'-menu-recolhido',{a11y:width===1366});await page.getByRole('button',{name:'Expandir menu',exact:true}).click();
  }
  await page.keyboard.press('Control+k');await expect(page.getByRole('textbox',{name:'Busca geral',exact:true})).toBeFocused();
  await page.getByRole('textbox',{name:'Busca geral',exact:true}).fill('Elisa');await expect(page.locator('.search-results')).toBeVisible();
 }
 await writeFile(join(output,'relatorio.json'),JSON.stringify({screens:results,violations,errors},null,2));
 expect(errors,'Erros do navegador').toEqual([]);
 expect(violations,'Violações WCAG detectadas; consulte relatorio.json').toEqual([]);
 console.log(`${results.length} verificações visuais aprovadas; sem overflow ou violações automáticas WCAG.`);
}catch(error){
 console.error(logs);
 const debug=await auditPage?.evaluate(()=>({overflow:document.body.style.overflow,bodyClass:document.body.className,scrollY,boxes:['#root','.app-shell','.workspace','.menu-toggle','.modal-overlay'].map(selector=>{const node=document.querySelector(selector);if(!node)return {selector};const box=node.getBoundingClientRect(),style=getComputedStyle(node);return {selector,inert:node.inert,x:box.x,y:box.y,width:box.width,height:box.height,display:style.display,visibility:style.visibility}})})).catch(()=>null);
 await auditPage?.screenshot({path:join(output,'falha.png'),timeout:10000}).catch(()=>{});
 await writeFile(join(output,'relatorio.json'),JSON.stringify({screens:results,violations,errors,debug,error:String(error)},null,2));throw error;
}
finally{
 if(browser)await browser.close();
 if(server&&server.exitCode===null){if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else server.kill('SIGTERM')}
}
