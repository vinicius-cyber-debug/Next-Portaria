import {loadApplicationEnvironment} from './postgres-config.mjs';
import {PostgresDatabase} from '../lib/persistence/postgres.ts';
import {loadExitAccess} from '../lib/exit-access/runtime.ts';

// Development only. The installed server starts this worker inside server-process.mjs.
if(loadApplicationEnvironment()!=='postgres')throw Error('As liberações de saída exigem PostgreSQL.');
if(!process.env.PORTO_EXIT_CONFIG)throw Error('Configure PORTO_EXIT_CONFIG antes de iniciar o serviço de saída.');
const db=new PostgresDatabase(JSON.parse(process.env.PORTO_PG_CONFIG));
let stop;
try{
 const runtime=await loadExitAccess(db,process.env.PORTO_EXIT_CONFIG);
 if(runtime.service.gateway.mode==='disabled')throw Error('A integração física está desativada na configuração.');
 stop=await runtime.startWorker();
 console.log('Serviço individual de saída iniciado. Não há liberações semanais em cache.');
 let closing=false;
 async function close(){if(closing)return;closing=true;await stop();await db.close();}
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void close());
}catch(error){await stop?.();await db.close();console.error(error.message);process.exitCode=1;}
