import {mkdir,readFile,writeFile,readdir,stat,lstat,rm,mkdtemp,copyFile,access} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,join,dirname,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {privateDirectory,recoveryKey,encryptBackupFile,decryptBackupFile} from './full-backup.mjs';
import {APP_VERSION} from './version.mjs';

const quote=value=>'"'+value.replaceAll('"','""')+'"';
const exists=path=>access(path).then(()=>true,()=>false);
const digest=async path=>{const hash=createHash('sha256');for await(const b of createReadStream(path))hash.update(b);return hash.digest('hex');};
async function files(root){const result=[];for(const e of await readdir(root,{withFileTypes:true})){const path=join(root,e.name);if(e.isSymbolicLink())throw Error('Links nao sao permitidos no backup.');if(e.isDirectory())result.push(...(await files(path)));else if(e.isFile())result.push(path);else throw Error('Tipo de arquivo nao suportado.');}return result.sort();}
function safePath(base,name){if(typeof name!=='string'||!name||name.includes('\\')||name.includes(':')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Manifesto contem caminho invalido.');const path=resolve(base,...name.split('/'));if(!path.startsWith(resolve(base)+sep))throw Error('Caminho fora da recuperacao.');return path;}
function pgTool(config,admin,tool,args){const result=spawnSync(join(config.bin,tool+(process.platform==='win32'?'.exe':'')),['--host',admin.host,'--port',String(admin.port),'--username',admin.user,...args],{windowsHide:true,encoding:'utf8',env:{...process.env,PGPASSWORD:admin.password,PGCONNECT_TIMEOUT:'5'}});if(result.status!==0)throw Error(`${tool} falhou: ${result.stderr||result.error?.message||'verifique o PostgreSQL'}`);}
export async function postgresInventory(pool){
 const client=await pool.connect(),tables=[];
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL TIME ZONE 'UTC'");
  const names=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
  for(const table of names){const hash=createHash('sha256');let count=0;
   await client.query(`DECLARE inventory_cursor NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS body FROM ${quote(table)} t ORDER BY row_to_json(t)::text`);
   while(true){const rows=(await client.query('FETCH 500 FROM inventory_cursor')).rows;if(!rows.length)break;for(const row of rows){hash.update(row.body+'\n');count++;}}
   await client.query('CLOSE inventory_cursor');tables.push({table,count,sha256:hash.digest('hex')});
  }
  await client.query('COMMIT');return tables;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function validateObjects(pool,root){
 const required=(await pool.query("SELECT object_key,size::bigint AS size,NULL::text AS sha256 FROM operational_attachments UNION ALL SELECT object_key,size_bytes AS size,sha256 FROM media_assets WHERE status='ready'")).rows;
 for(const object of required){const path=safePath(root,object.object_key);const info=await lstat(path).catch(()=>null);if(!info?.isFile()||info.isSymbolicLink()||info.size!==Number(object.size))throw Error('Arquivo referenciado ausente ou inconsistente.');if(object.sha256&&await digest(path)!==object.sha256)throw Error('A integridade de uma midia nao confere.');}
 return required.length;
}
async function decryptBundle({backupDirectory,keyFile,destination}){
 const key=await recoveryKey(keyFile);await privateDirectory(destination);const manifestPath=join(destination,'manifest.json');
 await decryptBackupFile(join(backupDirectory,'manifest.pgenc'),manifestPath,key);
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 if(manifest.format!=='next-portaria-postgres'||manifest.version!==1||!Array.isArray(manifest.files)||manifest.files.length>1000000)throw Error('Formato de backup PostgreSQL invalido.');
 const seen=new Set();
 for(const [i,entry] of manifest.files.entries()){
  if(!Number.isSafeInteger(entry.size)||entry.size<0||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Entrada invalida no manifesto.');
  const target=safePath(destination,entry.path);if(seen.has(target))throw Error('Caminho duplicado no manifesto.');seen.add(target);
  await decryptBackupFile(join(backupDirectory,String(i).padStart(8,'0')+'.pgenc'),target,key);
  if((await stat(target)).size!==entry.size||await digest(target)!==entry.sha256)throw Error('Arquivo recuperado diverge do manifesto.');
 }
 if(!seen.has(join(destination,'database.dump')))throw Error('Backup sem arquivo do banco.');return manifest;
}
async function recoverNewDatabase({config,staged,manifest,database,mediaRoot}){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(database))throw Error('Nome de banco de recuperacao invalido.');
 const admin=JSON.parse(await readFile(config.adminFile,'utf8')),control=new pg.Pool({...admin,database:'postgres'});
 let created=false,mediaCreated=false;
 try{
  if((await control.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount||await exists(mediaRoot))throw Error('Recuperacao exige um banco e uma pasta NOVOS.');
  await control.query(`CREATE DATABASE ${quote(database)}`);created=true;
  pgTool(config,admin,'pg_restore',['--exit-on-error','--single-transaction','--no-owner','--no-acl','--dbname',database,join(staged,'database.dump')]);
  const restored=new pg.Pool({...admin,database});
  try{
   if(JSON.stringify(await postgresInventory(restored))!==JSON.stringify(manifest.tables))throw Error('A conferencia dos registros recuperados falhou.');
   await mkdir(dirname(mediaRoot),{recursive:true,mode:0o700});await mkdir(mediaRoot,{mode:0o700});mediaCreated=true;await privateDirectory(mediaRoot);
   for(const entry of manifest.files.filter(e=>e.path.startsWith('objects/'))){const target=safePath(mediaRoot,entry.path.slice(8));await mkdir(dirname(target),{recursive:true,mode:0o700});await copyFile(safePath(staged,entry.path),target);}
   const references=await validateObjects(restored,mediaRoot);
   // The owner is needed only for recovery; application connections remain restricted.
   const role=config.database.user;if(!/^[a-z][a-z0-9_]*$/.test(role))throw Error('Papel de aplicacao invalido.');
   await restored.query(`GRANT USAGE ON SCHEMA public TO ${quote(role)}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${quote(role)}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quote(role)}; REVOKE ALL ON portaria_migrations FROM ${quote(role)}; REVOKE UPDATE,DELETE ON operational_audit FROM ${quote(role)}`);
   return {database,mediaRoot,references,tables:manifest.tables.length,verifiedAt:new Date().toISOString()};
  }finally{await restored.end();}
 }catch(error){if(created){await control.query(`DROP DATABASE ${quote(database)} WITH (FORCE)`);if(mediaCreated)await rm(mediaRoot,{recursive:true,force:true});}throw error;}
 finally{await control.end();}
}
export async function verifyPostgresBackup({config,backupDirectory,keyFile}){
 const temporary=await mkdtemp(join(config.dataRoot,'verify-')),staged=join(temporary,'staged'),database='portaria_verify_'+randomUUID().replaceAll('-','');
 let recovered=false;
 try{
  const manifest=await decryptBundle({backupDirectory,keyFile,destination:staged});
  const result=await recoverNewDatabase({config,staged,manifest,database,mediaRoot:join(temporary,'media')});recovered=true;return {verifiedAt:result.verifiedAt,tables:result.tables,references:result.references,temporaryRecovery:true};
 }finally{
  if(recovered){const admin=JSON.parse(await readFile(config.adminFile,'utf8')),pool=new pg.Pool({...admin,database:'postgres'});
   try{await pool.query(`DROP DATABASE ${quote(database)} WITH (FORCE)`);}finally{await pool.end();}}
  await rm(temporary,{recursive:true,force:true});
 }
}
export async function createPostgresBackup({config,destination,keyFile,quiesced=false}){
 if(!quiesced)throw Error('Encerre a aplicacao antes do backup conjunto de banco e arquivos.');
 destination=resolve(destination);
 if(destination===resolve(config.dataRoot)||destination.startsWith(resolve(config.mediaRoot)+sep)||destination.startsWith(resolve(config.cluster)+sep)||resolve(keyFile)===destination||resolve(keyFile).startsWith(destination+sep)||await exists(destination))throw Error('Destino de backup invalido ou existente.');
 await mkdir(dirname(destination),{recursive:true,mode:0o700});await mkdir(destination,{mode:0o700});await privateDirectory(destination);const key=await recoveryKey(keyFile,{create:true});
 const temporary=await mkdtemp(join(config.dataRoot,'backup-')),staged=join(temporary,'staged');await privateDirectory(staged);
 const admin=JSON.parse(await readFile(config.adminFile,'utf8')),pool=new pg.Pool({...admin,database:config.database.database});
 try{
  const tables=await postgresInventory(pool);await validateObjects(pool,config.mediaRoot);
  pgTool(config,admin,'pg_dump',['--format=custom','--no-owner','--no-acl','--file',join(staged,'database.dump'),config.database.database]);
  const entries=[{path:'database.dump',source:join(staged,'database.dump')}];
  for(const path of await files(config.mediaRoot))entries.push({path:'objects/'+path.slice(resolve(config.mediaRoot).length+1).split(sep).join('/'),source:path});
  const manifest={format:'next-portaria-postgres',version:1,applicationVersion:APP_VERSION,postgresMajor:17,createdAt:new Date().toISOString(),database:config.database.database,tables,files:[]};
  for(const [i,entry] of entries.entries()){
   manifest.files.push({path:entry.path,size:(await stat(entry.source)).size,sha256:await digest(entry.source)});
   await encryptBackupFile(entry.source,join(destination,String(i).padStart(8,'0')+'.pgenc'),key);
  }
  const manifestFile=join(temporary,'manifest.json');await writeFile(manifestFile,JSON.stringify(manifest),{mode:0o600});await encryptBackupFile(manifestFile,join(destination,'manifest.pgenc'),key);
  const verified=await verifyPostgresBackup({config,backupDirectory:destination,keyFile});
  const report={status:'verified',backupDirectory:destination,createdAt:manifest.createdAt,verifiedAt:verified.verifiedAt,files:manifest.files.length,tables:tables.length,references:verified.references};
  await writeFile(join(destination,'verification.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});return report;
 }catch(error){await rm(destination,{recursive:true,force:true});throw error;}
 finally{await pool.end();await rm(temporary,{recursive:true,force:true});}
}
export async function restorePostgresBackup({config,backupDirectory,keyFile,database,mediaRoot}){
 const temporary=await mkdtemp(join(config.dataRoot,'restore-'));
 try{const manifest=await decryptBundle({backupDirectory,keyFile,destination:join(temporary,'staged')});return await recoverNewDatabase({config,staged:join(temporary,'staged'),manifest,database,mediaRoot:resolve(mediaRoot)});}
 finally{await rm(temporary,{recursive:true,force:true});}
}
