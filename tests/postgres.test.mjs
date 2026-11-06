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
import {postgresInventory,createPostgresBackup,verifyPostgresBackup,restorePostgresBackup} from '../lib/postgres-backup.mjs';

test('SQL portavel conserva literais, parametros, aliases e insercao idempotente',()=>{
 assert.equal(postgresSql("SELECT '?' AS sample,? AS createdAt,'it''s ?' AS literal"),'SELECT \'?\' AS sample,$1 AS "createdAt",\'it\'\'s ?\' AS literal');
 assert.equal(postgresSql('INSERT OR IGNORE INTO x(id) VALUES(?) RETURNING id'),'INSERT INTO x(id) VALUES($1)  ON CONFLICT DO NOTHING RETURNING id');
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
  const bucket=new FileObjectStore(mediaRoot),origin='http://127.0.0.1:5199';let cookie='';
  const request=async(path,{method='GET',body,cookie:override,headers={}}={})=>{
   const h={...headers,cookie:override??cookie};if(method!=='GET'){h.origin??=origin;if(!(body instanceof FormData))h['content-type']='application/json';}
   const response=await handleApi(new Request(origin+'/api'+path,{method,headers:h,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)}),db,{bucket});
   const json=response.headers.get('content-type')?.includes('json');return {status:response.status,data:json?await response.json():new Uint8Array(await response.arrayBuffer()),response};
  };
  const state=async()=>(await request('/state')).data;
  const command=async(type,payload,revision)=>(await request('/commands',{method:'POST',body:{type,payload,revision:revision??(await state()).revision,idempotencyKey:randomUUID()}}));
  await t.test('migracoes sao repetiveis e a API usa papel sem privilegios administrativos',async()=>{
   assert.equal((await admin.query('SELECT count(*) AS n FROM portaria_migrations')).rows[0].n,'2');
   assert.equal((await db.prepare('SELECT usesuper FROM pg_user WHERE usename=current_user').first()).usesuper,false);
   assert.equal((await request('/session')).status,401);
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
  await t.test('backup criptografado restaura banco, imagem e midia e rejeita adulteracao',{skip:!local},async()=>{
   const adminFile=join(temp,'qa-admin.json');await writeFile(adminFile,JSON.stringify(owner),{mode:0o600});
   const config={...local,dataRoot:temp,adminFile,mediaRoot,database:{...owner,database,user:role,password:appPassword}};
   const destination=join(temp,'backup'),keyFile=join(temp,'recovery.key');
   const before=await postgresInventory(admin),backup=await createPostgresBackup({config,destination,keyFile,quiesced:true});assert.equal(backup.status,'verified');assert.equal(backup.references,2);assert.deepEqual(await postgresInventory(admin),before);
   const recoveredDatabase='portaria_recovered_'+token,recoveredMedia=join(temp,'recovered-media');
   try{const recovered=await restorePostgresBackup({config,backupDirectory:destination,keyFile,database:recoveredDatabase,mediaRoot:recoveredMedia});assert.equal(recovered.references,2);assert.equal((await new FileObjectStore(recoveredMedia).head('media/video-qa')).size,8*1024*1024);}finally{await control.query(`DROP DATABASE IF EXISTS "${recoveredDatabase}" WITH (FORCE)`);}
   const encrypted=join(destination,'00000000.pgenc'),contents=await readFile(encrypted);contents[40]^=1;await writeFile(encrypted,contents);
   await assert.rejects(verifyPostgresBackup({config,backupDirectory:destination,keyFile}),/criptogr|recuperado|integridade/i);
  });
 }finally{
  if(db)await db.close();if(admin)await admin.end();await control.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await control.query(`DROP ROLE IF EXISTS "${role}"`);await control.end();await rm(temp,{recursive:true,force:true});
 }
});
