import {readFile,writeFile,rm,access} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {connect} from 'node:net';
import pg from 'pg';
import {privateDirectory} from '../lib/full-backup.mjs';
import {configPath,postgresConfig,projectRoot} from './postgres-config.mjs';
import {migratePostgres,grantApplicationRole} from './postgres-migrations.mjs';
const args=process.argv.slice(2),action=args.shift()??'status';
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const exists=path=>access(path).then(()=>true,()=>false);
function executable(bin,name){return join(bin,name+(process.platform==='win32'?'.exe':''));}
function command(bin,name,args){const r=spawnSync(executable(bin,name),args,{encoding:'utf8',windowsHide:true,...(name==='pg_ctl'?{stdio:'ignore'}:{})});if(r.status!==0)throw Error(`${name} falhou. Confira postgres.log. ${r.stderr||r.stdout||r.error?.message||''}`);return r.stdout;}
async function portInUse(port){return new Promise(done=>{const s=connect({host:'127.0.0.1',port});s.setTimeout(1000);s.once('connect',()=>{s.destroy();done(true);});s.once('error',()=>done(false));s.once('timeout',()=>{s.destroy();done(false);});});}
export function startPostgres(config){const current=spawnSync(executable(config.bin,'pg_ctl'),['status','-D',config.cluster],{encoding:'utf8',windowsHide:true});if(current.status===0)return;command(config.bin,'pg_ctl',['start','-D',config.cluster,'-l',join(config.dataRoot,'postgres.log'),'-w','-t','60']);}
export async function initializePostgres({bin,dataRoot,port=55432}){
 if(await exists(configPath))throw Error('Configuracao ja existe. Use start ou migrate; nao inicialize novamente.');
 if(typeof bin!=='string'||typeof dataRoot!=='string'||!isAbsolute(bin)||!isAbsolute(dataRoot))throw Error('Use caminhos absolutos para binarios e dados.');
 if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Porta PostgreSQL invalida.');
 const cluster=join(dataRoot,'postgres'),adminFile=join(dataRoot,'admin.json'),pendingFile=configPath.replace('.json','.pending.json');
 const resuming=await exists(join(cluster,'PG_VERSION'));
 if(resuming&&(!await exists(adminFile)||(await readFile(join(cluster,'PG_VERSION'),'utf8')).trim()!=='17'))throw Error('Cluster preexistente sem configuracao reconhecida. Nenhum dado alterado.');
 if(!resuming&&await portInUse(port))throw Error('Porta PostgreSQL ocupada.');
 await privateDirectory(dataRoot);await privateDirectory(join(projectRoot,'.porto-runtime'));await privateDirectory(join(dataRoot,'media'));await privateDirectory(join(dataRoot,'backups'));
 const password=randomBytes(32).toString('hex'),appPassword=randomBytes(32).toString('hex'),passwordFile=join(dataRoot,'init-password.tmp');
 const admin=resuming?JSON.parse(await readFile(adminFile,'utf8')):{host:'127.0.0.1',port,user:'portaria_owner',password,database:'postgres'};
 if(admin.host!=='127.0.0.1'||admin.port!==port)throw Error('A configuracao do cluster nao corresponde a porta solicitada.');
 if(!resuming){
  await writeFile(adminFile,JSON.stringify(admin),{mode:0o600,flag:'wx'});
  await writeFile(passwordFile,password+'\n',{mode:0o600,flag:'wx'});
  try{command(bin,'initdb',['-D',cluster,'-U','portaria_owner','--pwfile',passwordFile,'--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C']);}finally{await rm(passwordFile,{force:true});}
  await writeFile(join(cluster,'postgresql.auto.conf'),`listen_addresses = '127.0.0.1'\nport = ${port}\ntimezone = 'America/Manaus'\npassword_encryption = 'scram-sha-256'\n`,{mode:0o600});
 }
 const pending=await exists(pendingFile)?JSON.parse(await readFile(pendingFile,'utf8')):null;
 if(pending&&(pending.dataRoot!==dataRoot||pending.bin!==bin))throw Error('Existe uma preparacao pendente de outro diretorio.');
 const config=pending??{version:1,provider:'postgres',bin,dataRoot,cluster,adminFile,mediaRoot:join(dataRoot,'media'),database:{host:'127.0.0.1',port,user:'portaria_app',password:appPassword,database:'next_portaria_dev'}};
 if(!pending)await writeFile(pendingFile,JSON.stringify(config),{mode:0o600,flag:'wx'});
 startPostgres(config);
 const pool=new pg.Pool(admin);
 try{
  if(!(await pool.query("SELECT 1 FROM pg_roles WHERE rolname='portaria_app'")).rowCount)await pool.query(`CREATE ROLE portaria_app LOGIN PASSWORD '${config.database.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  else if(!pending)throw Error('Papel PostgreSQL existente sem credencial pendente reconhecida. Nenhuma senha redefinida.');
  if(!(await pool.query("SELECT 1 FROM pg_database WHERE datname='next_portaria_dev'")).rowCount)await pool.query('CREATE DATABASE next_portaria_dev OWNER portaria_owner');
 }finally{await pool.end();}
 const owner=new pg.Pool({...admin,database:config.database.database});
 try{await migratePostgres(owner);await grantApplicationRole(owner);}finally{await owner.end();}
 await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
 await rm(pendingFile,{force:true});
 console.log(JSON.stringify({status:'ready',provider:'postgres',port,dataRoot,database:config.database.database}));return config;
}
import {fileURLToPath} from 'node:url';
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(action==='init')await initializePostgres({bin:option('--bin'),dataRoot:option('--data-root'),port:Number(option('--port')??55432)});
  else{
   const config=postgresConfig();
   if(action==='start'){startPostgres(config);console.log('PostgreSQL local iniciado.');}
   else if(action==='stop'){command(config.bin,'pg_ctl',['stop','-D',config.cluster,'-m','fast','-w']);console.log('PostgreSQL local encerrado.');}
   else if(action==='status'){const r=spawnSync(executable(config.bin,'pg_ctl'),['status','-D',config.cluster],{encoding:'utf8',windowsHide:true});console.log(JSON.stringify({provider:'postgres',running:r.status===0,host:config.database.host,port:config.database.port,database:config.database.database}));}
   else if(action==='migrate'){startPostgres(config);const admin=JSON.parse(await readFile(config.adminFile,'utf8')),pool=new pg.Pool({...admin,database:config.database.database});try{await migratePostgres(pool);await grantApplicationRole(pool,config.database.user);}finally{await pool.end();}console.log('Migracoes PostgreSQL verificadas.');}
   else throw Error('Use init, start, stop, status ou migrate.');
  }
 }catch(error){console.error('ERRO:',error.message);process.exitCode=1;}
}
