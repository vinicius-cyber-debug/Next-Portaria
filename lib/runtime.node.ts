import {PostgresDatabase} from './persistence/postgres.ts';
import {FileObjectStore} from './storage/filesystem.ts';
import type {RuntimeResources} from './persistence/contracts.ts';
import {MediaService} from './media.ts';
import {PortoService} from './porto/service.ts';
import {IdSecureMonitor} from './integrations/monitor.ts';
const globalRuntime=globalThis as typeof globalThis&{__portariaPg?:RuntimeResources};
export function getResources():RuntimeResources {
  if(!process.env.PORTO_PG_CONFIG||!process.env.PORTO_MEDIA_ROOT)throw Error('Configure PostgreSQL e o armazenamento privado antes de iniciar.');
  if(globalRuntime.__portariaPg)return globalRuntime.__portariaPg;
  const db=new PostgresDatabase(JSON.parse(process.env.PORTO_PG_CONFIG)),bucket=new FileObjectStore(process.env.PORTO_MEDIA_ROOT);
  return globalRuntime.__portariaPg= {
    db,bucket,media:new MediaService(db,bucket),porto:new PortoService(db,process.env.PORTO_PORTO_ENABLED==='true'),monitor:new IdSecureMonitor(db,process.env.PORTO_IDSECURE_CONFIG??''),
    jobToken:process.env.PORTO_JOB_TOKEN,allowHttpLan:process.env.PORTO_ALLOW_HTTP_LAN==='true',
  };
}
