import {join,resolve} from 'node:path';
import {postgresConfig} from './postgres-config.mjs';
import {createPostgresBackup,verifyPostgresBackup,restorePostgresBackup} from '../lib/postgres-backup.mjs';
const args=process.argv.slice(2),action=args.shift(),value=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
try{
 const config=postgresConfig(),keyFile=resolve(value('--key',join(config.dataRoot,'recovery.key')));
 let result;
 if(action==='create'){
  if(!args.includes('--offline'))throw Error('Encerre a aplicacao e informe --offline.');
  const response=await fetch(`http://127.0.0.1:${Number(process.env.PORTO_PORT??5180)}/`,{signal:AbortSignal.timeout(1500)}).catch(()=>null);
  if(response)throw Error('Encerre a aplicacao local antes de copiar banco e arquivos.');
  result=await createPostgresBackup({config,destination:resolve(value('--destination',join(config.dataRoot,'backups',new Date().toISOString().replaceAll(':','-')))),keyFile,quiesced:true});
 }else if(action==='verify'&&value('--backup'))result=await verifyPostgresBackup({config,backupDirectory:resolve(value('--backup')),keyFile});
 else if(action==='restore'&&value('--backup')&&value('--database')&&value('--media-root'))result=await restorePostgresBackup({config,backupDirectory:resolve(value('--backup')),keyFile,database:value('--database'),mediaRoot:resolve(value('--media-root'))});
 else throw Error('Use create --offline, verify --backup PASTA ou restore --backup PASTA --database BANCO_NOVO --media-root PASTA_NOVA.');
 console.log(JSON.stringify(result,null,2));
}catch(error){console.error('ERRO:',error.message);process.exitCode=1;}
