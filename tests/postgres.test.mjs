import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {PostgresDatabase,postgresSql} from '../lib/persistence/postgres.ts';
import {FileObjectStore} from '../lib/storage/filesystem.ts';
import {migratePostgres} from '../scripts/postgres-migrations.mjs';
import {hashPassword} from '../lib/local-auth.ts';
import {handleApi} from '../lib/server.ts';
import {MediaService,MEDIA_LIMITS,byteRange} from '../lib/media.ts';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {spawn,spawnSync} from 'node:child_process';
import {request as httpsRequest} from 'node:https';
import {createServer as tcpServer} from 'node:net';
import {checkServerIdentity} from 'node:tls';
import {postgresInventory,createPostgresBackup,verifyPostgresBackup,restorePostgresBackup} from '../lib/postgres-backup.mjs';

test('SQL portavel conserva literais, parametros, aliases e insercao idempotente',()=>{
 assert.equal(postgresSql("SELECT '?' AS sample,? AS createdAt,'it''s ?' AS literal"),'SELECT \'?\' AS sample,$1 AS "createdAt",\'it\'\'s ?\' AS literal');
 assert.equal(postgresSql('INSERT OR IGNORE INTO x(id) VALUES(?) RETURNING id'),'INSERT INTO x(id) VALUES($1)  ON CONFLICT DO NOTHING RETURNING id');
});
test('conflito de transacao anterior ao comando retorna HTTP 409',async()=>{
 const statement={bind(){return this;}};
 const provider={prepare(){return statement;},async batch(){throw Error('REVISION_CONFLICT');}};
 const response=await handleApi(new Request('http://127.0.0.1/api/state'),provider);assert.equal(response.status,409);assert.equal((await response.json()).error.code,'REVISION_CONFLICT');
});

const localPath=resolve('.porto-runtime/postgres.json');
const supplied=process.env.PORTO_TEST_POSTGRES_CONFIG?JSON.parse(process.env.PORTO_TEST_POSTGRES_CONFIG):null;
test('PostgreSQL real: migracoes, API, concorrencia, arquivos privados e recuperacao',{skip:!supplied&&!existsSync(localPath),timeout:180000},async t=>{
 const local=existsSync(localPath)?JSON.parse(await readFile(localPath,'utf8')):null;
 const owner=supplied??JSON.parse(await readFile(local.adminFile,'utf8'));
 const token=randomUUID().replaceAll('-',''),database='portaria_qa_'+token,role='qa_'+token;
 const control=new pg.Pool({...owner,database:'postgres'}),password='QA-'+randomBytes(20).toString('hex');
 const temp=await mkdtemp(join(tmpdir(),'portaria-postgres-')),mediaRoot=join(temp,'objects');await mkdir(mediaRoot);
 const appPassword=randomBytes(32).toString('hex');
 let admin,db,visitId,attachmentId;
 try{
  await control.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await control.query(`CREATE DATABASE "${database}"`);admin=new pg.Pool({...owner,database});
  await migratePostgres(admin);await migratePostgres(admin);
  await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${role}"; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"; REVOKE UPDATE,DELETE ON operational_audit FROM "${role}"; REVOKE ALL ON portaria_migrations FROM "${role}"`);
  db=new PostgresDatabase({...owner,database,user:role,password:appPassword,max:5});
  const bucket=new FileObjectStore(mediaRoot),media=new MediaService(db,bucket),origin='http://127.0.0.1:5199';let cookie='',incidentId;
  const request=async(path,{method='GET',body,cookie:override,headers={}}={})=>{
   const raw=body instanceof Uint8Array||body instanceof ReadableStream;
   const h={...headers,cookie:override??cookie};if(!['GET','HEAD'].includes(method)){h.origin??=origin;if(!(body instanceof FormData))h['content-type']??=raw?'application/octet-stream':'application/json';}
   const response=await handleApi(new Request(origin+'/api'+path,{method,headers:h,body:body===undefined?undefined:body instanceof FormData||raw?body:JSON.stringify(body),duplex:'half'}),db,{bucket,media});
   const json=response.headers.get('content-type')?.includes('json');return {status:response.status,data:json?await response.json():new Uint8Array(await response.arrayBuffer()),response};
  };
  const state=async()=>(await request('/state')).data;
  const command=async(type,payload,revision)=>(await request('/commands',{method:'POST',body:{type,payload,revision:revision??(await state()).revision,idempotencyKey:randomUUID()}}));
  await t.test('migracoes sao repetiveis e a API usa papel sem privilegios administrativos',async()=>{
   assert.equal((await admin.query('SELECT count(*) AS n FROM portaria_migrations')).rows[0].n,'3');
   assert.equal((await db.prepare('SELECT usesuper FROM pg_user WHERE usename=current_user').first()).usesuper,false);
   assert.equal((await request('/session')).status,401);
  });
  await t.test('checksum aceita somente a conversao LF/CRLF e rejeita SQL divergente',async()=>{
   const sql=(await readFile(new URL('../database/postgres/001_core.sql',import.meta.url),'utf8')).replaceAll('\r\n','\n'),hash=createHash('sha256').update(sql).digest('hex');
   await admin.query("UPDATE portaria_migrations SET sha256=$1 WHERE version='001_core.sql'",[createHash('sha256').update(sql.replaceAll('\n','\r\n')).digest('hex')]);
   await migratePostgres(admin);assert.equal((await admin.query("SELECT sha256 FROM portaria_migrations WHERE version='001_core.sql'")).rows[0].sha256,hash);
   const archived=await readFile(new URL('../database/postgres/legacy/001_core.sql',import.meta.url),'utf8');assert.equal(archived.replaceAll('\r\n','\n'),sql);
   await admin.query("UPDATE portaria_migrations SET sha256=$1 WHERE version='001_core.sql'",[createHash('sha256').update(archived).digest('hex')]);await migratePostgres(admin);
   await admin.query("UPDATE portaria_migrations SET sha256=$1 WHERE version='001_core.sql'",['0'.repeat(64)]);await assert.rejects(migratePostgres(admin),/ja aplicada foi alterada/);
   await admin.query("UPDATE portaria_migrations SET sha256=$1 WHERE version='001_core.sql'",[hash]);
  });
  await t.test('login real preserva contrato de sessao e CSRF',async()=>{
   const secret=await hashPassword(password),now=new Date().toISOString();
   await admin.query("INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES('qa_admin','qa@example.test','Administracao QA','admin','active',$1,$1)",[now]);
   await admin.query("INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at,must_change_password) VALUES('qa_admin','admin.qa',$1,$2,$3,$4,0)",[secret.salt,secret.hash,secret.iterations,now]);
   const login=await request('/auth/login',{method:'POST',body:{username:'admin.qa',password}});assert.equal(login.status,200);cookie=login.response.headers.get('set-cookie').split(';')[0];
   assert.equal((await request('/session')).data.user.name,'Administracao QA');
   assert.equal((await request('/auth/login',{method:'POST',body:{username:'admin.qa',password},headers:{origin:'http://other.example'}})).status,403);
  });
  await t.test('solicitacao, aprovacao, identidade, entrada e busca paginada funcionam no PostgreSQL',async()=>{
   const visit=await command('VISITOR_REQUEST',{name:'Pessoa QA',company:'Empresa QA',host:'Responsavel QA',purpose:'Teste de migracao',documentLast4:'1234',expectedAt:new Date().toISOString(),validUntil:new Date(Date.now()+3600000).toISOString()});assert.equal(visit.status,200,JSON.stringify(visit.data));visitId=visit.data.result.id;
   assert.equal((await command('VISITOR_APPROVE',{id:visitId})).status,200);
   assert.equal((await command('VISITOR_CHECKIN',{id:visitId})).status,400);
   assert.equal((await command('VISITOR_CHECKIN',{id:visitId,identityConfirmed:true})).status,200);
   const page=await request('/records?collection=visitors&q=Pessoa');assert.equal(page.status,200,JSON.stringify(page.data));assert.equal(page.data.total,1);
  });
  await t.test('escritas concorrentes com a mesma revisao nao se sobrescrevem',async()=>{
   const revision=(await state()).revision;
   const outcomes=await Promise.all(['Empresa A','Empresa B'].map(name=>command('MASTER_SAVE',{kind:'companies',record:{name}},revision)));
   assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409],JSON.stringify(outcomes));
   assert.equal((await state()).state.companies.length,1);
  });
  await t.test('transacao reverte por inteiro e auditoria e ultimo administrador ficam protegidos',async()=>{
   await assert.rejects(db.batch([db.prepare("INSERT INTO operational_settings(id,body) VALUES('rollback_qa','{}')"),db.prepare('INSERT INTO tabela_inexistente VALUES(1)')]));
   assert.equal(await db.prepare("SELECT id FROM operational_settings WHERE id='rollback_qa'").first(),null);
   await assert.rejects(admin.query("UPDATE operational_audit SET body='{}'"),/AUDIT_IMMUTABLE/);
   await assert.rejects(admin.query("UPDATE operational_users SET role='reader' WHERE id='qa_admin'"),/LAST_ADMIN/);
  });
  await t.test('anexo usa arquivo privado, pode ser recuperado e exige sessao',async()=>{
   const form=new FormData(),bytes=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);form.append('file',new File([bytes],'foto-qa.png',{type:'image/png'}));
   const upload=await request('/attachments',{method:'POST',body:form});assert.equal(upload.status,200,JSON.stringify(upload.data));attachmentId=upload.data.attachment.id;
   assert.deepEqual((await request('/attachments/'+attachmentId)).data,bytes);
   assert.equal((await request('/attachments/'+attachmentId,{cookie:''})).status,401);
   await assert.rejects(bucket.put('../escape',bytes),/invalida/);
  });
  await t.test('estrutura de midia exige integridade e armazenamento aceita fluxo limitado',async()=>{
   await assert.rejects(admin.query("INSERT INTO media_assets(id,object_key,original_name,mime_type,status,created_by) VALUES('bad','bad','video.mp4','video/mp4','ready','qa_admin')"),/ready_media_integrity/);
   const key='media/video-qa',chunk=Buffer.alloc(256*1024,7),hash=createHash('sha256');for(let i=0;i<32;i++)hash.update(chunk);
   let sent=0;const stream=new ReadableStream({pull(controller){if(sent++===32)controller.close();else controller.enqueue(chunk);}});
   const result=await bucket.putStream(key,stream,9*1024*1024);assert.equal(result.size,8*1024*1024);assert.equal(result.sha256,hash.digest('hex'));
   await admin.query("INSERT INTO media_assets(id,object_key,original_name,mime_type,size_bytes,sha256,status,created_by) VALUES('video_qa',$1,'video.mp4','video/mp4',$2,$3,'ready','qa_admin')",[key,result.size,result.sha256]);
   await admin.query("INSERT INTO media_links(asset_id,collection,record_id) VALUES('video_qa','visitors',$1)",[visitId]);
   await assert.rejects(bucket.putStream('media/too-big',new ReadableStream({start(c){c.enqueue(chunk);c.close();}}),1024),/excede/);
   assert.equal(await bucket.head('media/too-big'),null);
  });
  const begin=async(bytes,name='teste.mp4',type='video/mp4',extra={})=>request('/media/uploads',{method:'POST',body:{recordId:incidentId,size:bytes.length,name,type},...extra});
  const part=async(id,index,bytes,extra={})=>request(`/media/uploads/${id}/parts/${index}`,{method:'PUT',body:bytes,headers:{'x-content-sha256':createHash('sha256').update(bytes).digest('hex')},...extra});
  let uploaded;
  const video=await readFile(new URL('../docs/assets/fluxo-visita.mp4',import.meta.url));
  await t.test('video real usa retomada, partes idempotentes, integridade, sessao e intervalos HTTP',async()=>{
   const incident=await command('INCIDENT_CREATE',{title:'Evidencia QA',description:'Upload privado',category:'Operacional',severity:'low',location:'Portaria',responsible:'QA'});assert.equal(incident.status,200,JSON.stringify(incident.data));incidentId=incident.data.result.id;
   assert.equal((await request('/media/uploads',{method:'POST',body:{recordId:incidentId,size:MEDIA_LIMITS.video+1,name:'grande.mp4',type:'video/mp4'}})).status,400);
   const bytes=Buffer.concat([video,Buffer.alloc(MEDIA_LIMITS.chunk+100)]),started=await begin(bytes);assert.equal(started.status,201,JSON.stringify(started.data));const id=started.data.id;
   assert.equal((await request(`/media/${started.data.assetId}/content`)).status,404);
   const first=bytes.subarray(0,MEDIA_LIMITS.chunk),last=bytes.subarray(MEDIA_LIMITS.chunk);
   assert.equal((await part(id,0,first)).status,200);
   assert.equal((await part(id,0,first)).status,200);
   assert.equal((await request('/media/uploads/'+id)).data.parts.length,1);
   assert.equal((await request('/media/uploads/'+id+'/complete',{method:'POST'})).status,409);
   assert.equal((await part(id,1,last,{headers:{'x-content-sha256':'0'.repeat(64)}})).status,422);
   assert.equal((await request('/media/uploads/'+id)).data.parts.length,1);
   assert.equal((await part(id,1,last)).status,200);
   const complete=await request('/media/uploads/'+id+'/complete',{method:'POST'});assert.equal(complete.status,200,JSON.stringify(complete.data));uploaded=complete.data.assetId;
   assert.equal(complete.data.sha256,createHash('sha256').update(bytes).digest('hex'));
   assert.equal((await request('/media/uploads/'+id+'/complete',{method:'POST'})).data.replayed,true);
   assert.equal((await request('/media/'+uploaded+'/content',{cookie:''})).status,401);
   const range=await request('/media/'+uploaded+'/content',{headers:{range:'bytes=0-31'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(range.data),bytes.subarray(0,32));assert.equal(range.response.headers.get('content-range'),`bytes 0-31/${bytes.length}`);
   assert.equal((await request('/media/'+uploaded+'/content',{headers:{range:'bytes=9999999999-'}})).status,416);
   assert.equal((await request('/media/'+uploaded+'/content',{method:'HEAD'})).response.headers.get('content-length'),String(bytes.length));
   assert.equal((await request('/media/records?id='+incidentId)).data.assets.length,1);
   assert.deepEqual(byteRange('bytes=-10',100),{start:90,end:99});assert.equal(byteRange('bytes=0-2,4-6',100),false);
  });
  await t.test('conteudo disfarçado e revogacao durante envio nao publicam arquivos',async()=>{
   const fake=Buffer.from('isto nao e um video'),bad=await begin(fake);assert.equal(bad.status,201);await part(bad.data.id,0,fake);
   assert.equal((await request('/media/uploads/'+bad.data.id+'/complete',{method:'POST'})).status,422);
   assert.equal((await request('/media/'+bad.data.assetId+'/content')).status,404);
   await request('/media/uploads/'+bad.data.id,{method:'DELETE'});
   const now=new Date().toISOString(),secret=await hashPassword(password),token=randomBytes(32).toString('hex'),otherCookie='porto_session='+token;
   await admin.query("INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES('qa_gate','gate@example.test','Portaria QA','gate','active',$1,$1)",[now]);
   await admin.query("INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at,must_change_password) VALUES('qa_gate','gate.qa',$1,$2,$3,$4,0)",[secret.salt,secret.hash,secret.iterations,now]);
   await admin.query("INSERT INTO operational_sessions(token_hash,user_id,created_at,expires_at) VALUES($1,'qa_gate',$2,$3)",[createHash('sha256').update(token).digest('hex'),now,new Date(Date.now()+3600000).toISOString()]);
   const started=await begin(video,'teste.mp4','video/mp4',{cookie:otherCookie});assert.equal(started.status,201);
   assert.equal((await request('/media/uploads/'+started.data.id)).status,404);
   let pushed=false;const slow=new ReadableStream({async pull(c){if(pushed){c.close();return;}pushed=true;await admin.query("INSERT INTO operational_access(user_id,body) VALUES('qa_gate','{\"documentView\":false}')");c.enqueue(video);}},{highWaterMark:0});
   assert.equal((await part(started.data.id,0,video,{cookie:otherCookie,body:slow})).status,403);
   assert.equal((await admin.query('SELECT count(*) AS n FROM media_upload_parts WHERE upload_id=$1',[started.data.id])).rows[0].n,'0');
   await admin.query("DELETE FROM operational_access WHERE user_id='qa_gate'");await request('/media/uploads/'+started.data.id,{method:'DELETE',cookie:otherCookie});
   const expired=await begin(video,'teste.mp4','video/mp4',{cookie:otherCookie});assert.equal(expired.status,201);
   let sent=false;const loggedOut=new ReadableStream({async pull(c){if(sent){c.close();return;}sent=true;await admin.query("DELETE FROM operational_sessions WHERE user_id='qa_gate'");c.enqueue(video);}},{highWaterMark:0});
   assert.equal((await part(expired.data.id,0,video,{cookie:otherCookie,body:loggedOut})).status,401);
   assert.equal((await admin.query('SELECT count(*) AS n FROM media_upload_parts WHERE upload_id=$1',[expired.data.id])).rows[0].n,'0');await admin.query("UPDATE media_uploads SET expires_at=now()-interval '1 day' WHERE id=$1",[expired.data.id]);
  });
  await t.test('doze envios concorrentes aplicam a cota sem esgotar conexoes ou publicar extras',async()=>{
   const results=await Promise.all(Array.from({length:12},()=>begin(Buffer.alloc(100))));
   assert.deepEqual(results.map(r=>r.status).sort(),[201,201,201,429,429,429,429,429,429,429,429,429]);
   for(const result of results.filter(r=>r.status===201))assert.equal((await request('/media/uploads/'+result.data.id,{method:'DELETE'})).status,200);
  });
  await t.test('navegador reproduz o MP4 privado com requisicoes de intervalo',{skip:process.env.PORTO_TEST_VIDEO_BROWSER!=='true'},async()=>{
   const {chromium}=await import('@playwright/test');
   const http=createServer(async(req,res)=>{try{if(!req.url.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end(`<video muted controls autoplay src="/api/media/${uploaded}/content"></video>`);return;}const response=await handleApi(new Request('http://127.0.0.1'+req.url,{headers:req.headers}),db,{bucket,media});res.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(res);else res.end();}catch{res.writeHead(500);res.end();}});
   await new Promise(done=>http.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+http.address().port;
   const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
   try{const context=await browser.newContext();await context.addCookies([{name:'porto_session',value:cookie.split('=')[1],url:base}]);const page=await context.newPage();await page.goto(base);await page.waitForFunction(()=>{const video=document.querySelector('video');return video.readyState>=2&&video.currentTime>0&&video.videoWidth>0;},{timeout:30000});assert.ok(await page.locator('video').evaluate(v=>v.duration>0));}
   finally{await browser.close();await new Promise(done=>http.close(done));}
  });
  await t.test('retencao e cancelamento removem arquivos, preservam auditoria e podem repetir',async()=>{
   assert.equal((await request('/media/policy')).data.retentionDays,null);
   assert.equal((await request('/media/policy',{method:'POST',body:{retentionDays:1}})).status,400);
   assert.equal((await request('/media/policy',{method:'POST',body:{retentionDays:1,confirmExisting:true}})).status,200);
   await admin.query("UPDATE media_assets SET expires_at=now()-interval '1 day' WHERE id=$1",[uploaded]);
   assert.equal((await request('/media/'+uploaded+'/content')).status,404);
   assert.equal((await request('/media/retention/run',{method:'POST'})).status,200);
   assert.equal(await bucket.head('media/'+uploaded),null);
   assert.equal((await request('/media/retention/run',{method:'POST'})).data.purged,0);
   assert.ok(Number((await admin.query("SELECT count(*) AS n FROM operational_audit WHERE body::jsonb->>'action'='MEDIA_RETENTION_RUN'")).rows[0].n)>0);
   await request('/media/policy',{method:'POST',body:{retentionDays:null,confirmExisting:true}});
  });
  await t.test('gateway HTTPS nativo valida certificado, origem, cookie seguro e API privada',{skip:process.env.PORTO_TEST_HTTPS!=='true',timeout:120000},async()=>{
   const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl',cert=join(temp,'gateway.pem'),key=join(temp,'gateway.key');
   const generated=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{encoding:'utf8',windowsHide:true});assert.equal(generated.status,0,'Nao foi possivel gerar certificado QA.');
   const freePort=async()=>{const socket=tcpServer();await new Promise(done=>socket.listen(0,'127.0.0.1',done));const port=socket.address().port;await new Promise(done=>socket.close(done));return port;};
   const port=await freePort(),uiPort=await freePort(),configFile=join(temp,'server.json');
   await writeFile(configFile,JSON.stringify({host:'127.0.0.1',subnet:'127.0.0.0/8',port,uiPort,cert,key}));
   const child=spawn(process.execPath,['--experimental-strip-types','scripts/server-process.mjs'],{cwd:resolve('.'),windowsHide:true,detached:process.platform!=='win32',env:{...process.env,PORTO_DB_PROVIDER:'postgres',PORTO_PG_CONFIG:JSON.stringify({...owner,database,user:role,password:appPassword}),PORTO_MEDIA_ROOT:mediaRoot,PORTO_SERVER_CONFIG:configFile,PORTO_NATIVE_PROCESS_FILE:join(temp,'gateway-process.json')},stdio:['ignore','pipe','pipe']});
   let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',d=>{logs=(logs+d).slice(-4000);});
   const ca=await readFile(cert),origin=`https://127.0.0.1:${port}`;
   const call=(path,options={},data)=>new Promise((done,fail)=>{const req=httpsRequest(origin+path,{ca,timeout:3000,checkServerIdentity:(_host,cert)=>checkServerIdentity('127.0.0.1',cert),...options},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>done({status:res.statusCode,headers:res.headers,body}));});req.on('error',fail);req.on('timeout',()=>req.destroy(Error('Timeout')));if(data)req.write(JSON.stringify(data));req.end();});
   try{
    const deadline=Date.now()+60000;while(true){const result=await call('/').catch(()=>null);if(result?.status===200)break;if(Date.now()>deadline||child.exitCode!==null)throw Error('HTTPS QA nao iniciou. '+logs);await new Promise(done=>setTimeout(done,500));}
    assert.equal((await call('/api/session')).status,401);
    assert.equal((await call('/api/media/policy')).status,401);
    assert.equal((await call('/',{headers:{host:'intruso.invalid'}})).status,403);
    const login=await call('/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'}},{username:'admin.qa',password});assert.equal(login.status,200,login.body);assert.match(login.headers['set-cookie'][0],/; Secure/);
    assert.equal((await call('/api/auth/login',{method:'POST',headers:{origin:'https://intruso.invalid','content-type':'application/json'}},{username:'admin.qa',password})).status,403);
    if(process.env.PORTO_TEST_VIDEO_BROWSER==='true'){
     const {chromium,expect}=await import('@playwright/test'),browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
     try{
      const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});await context.addCookies([{name:'porto_session',value:login.headers['set-cookie'][0].split(';')[0].split('=')[1],url:origin,secure:true}]);
      const page=await context.newPage(),file=join(temp,'evidencia-real-qa.mp4');await writeFile(file,Buffer.concat([video,Buffer.alloc(MEDIA_LIMITS.chunk)]));
      let interrupted=false,firstPartRequests=0;
      await page.route('**/api/media/uploads/*/parts/*',async route=>{if(route.request().url().endsWith('/parts/0'))firstPartRequests++;if(route.request().url().endsWith('/parts/1')&&!interrupted){interrupted=true;await route.abort();}else await route.continue();});
      const openIncident=async()=>{await page.getByRole('button',{name:/Ocorrências e turnos/}).first().click();await page.getByRole('button',{name:/Evidencia QA/}).click();};
      await page.goto(origin);await openIncident();
      await page.getByLabel('Adicionar foto ou vídeo').setInputFiles(file);await page.getByRole('button',{name:'Enviar ou retomar',exact:true}).click();
      await expect(page.getByRole('alert')).toBeVisible({timeout:30000});await expect(page.getByRole('button',{name:'Enviar ou retomar',exact:true})).toBeEnabled();assert.equal(firstPartRequests,1);
      await page.reload();await openIncident();await page.getByLabel('Adicionar foto ou vídeo').setInputFiles(file);await page.getByRole('button',{name:'Enviar ou retomar',exact:true}).click();
      await expect(page.getByText('Arquivo enviado e conferido.',{exact:true})).toBeVisible({timeout:30000});
      assert.equal(firstPartRequests,1,'A retomada deve conferir a parte existente sem reenvia-la.');
      await page.locator('video').evaluate(video=>{video.muted=true;return video.play();});await page.waitForFunction(()=>document.querySelector('video')?.currentTime>0);
      if(process.platform==='win32')await page.screenshot({path:resolve('..','NextPortaria-validacao-videos.png'),fullPage:true});
     }finally{await browser.close();}
    }
   }finally{
    if(child.exitCode===null){if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else process.kill(-child.pid,'SIGTERM');await Promise.race([new Promise(done=>child.once('exit',done)),new Promise(done=>setTimeout(done,6000))]);if(child.exitCode===null&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');}
   }
  });
  await t.test('backup criptografado restaura banco, imagem e midia e rejeita adulteracao',{skip:!local},async()=>{
   const adminFile=join(temp,'qa-admin.json');await writeFile(adminFile,JSON.stringify(owner),{mode:0o600});
   const config={...local,dataRoot:temp,adminFile,mediaRoot,database:{...owner,database,user:role,password:appPassword}};
   const destination=join(temp,'backup'),keyFile=join(temp,'recovery.key');
   const references=Number((await admin.query("SELECT (SELECT count(*) FROM operational_attachments)+(SELECT count(*) FROM media_assets WHERE status='ready') AS n")).rows[0].n);
   const before=await postgresInventory(admin),backup=await createPostgresBackup({config,destination,keyFile,quiesced:true});assert.equal(backup.status,'verified');assert.equal(backup.references,references);assert.deepEqual(await postgresInventory(admin),before);
   const recoveredDatabase='portaria_recovered_'+token,recoveredMedia=join(temp,'recovered-media');
   try{const recovered=await restorePostgresBackup({config,backupDirectory:destination,keyFile,database:recoveredDatabase,mediaRoot:recoveredMedia});assert.equal(recovered.references,references);assert.equal((await new FileObjectStore(recoveredMedia).head('media/video-qa')).size,8*1024*1024);}finally{await control.query(`DROP DATABASE IF EXISTS "${recoveredDatabase}" WITH (FORCE)`);}
   const encrypted=join(destination,'00000000.pgenc'),contents=await readFile(encrypted);contents[40]^=1;await writeFile(encrypted,contents);
   await assert.rejects(verifyPostgresBackup({config,backupDirectory:destination,keyFile}),/criptogr|recuperado|integridade/i);
  });
 }finally{
  if(db)await db.close();if(admin)await admin.end();await control.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await control.query(`DROP ROLE IF EXISTS "${role}"`);await control.end();await rm(temp,{recursive:true,force:true});
 }
});
