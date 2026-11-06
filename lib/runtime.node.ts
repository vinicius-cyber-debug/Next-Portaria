import {PostgresDatabase} from './persistence/postgres.ts';
import {FileObjectStore} from './storage/filesystem.ts';
import type {RuntimeResources} from './persistence/contracts.ts';
const globalRuntime=globalThis as typeof globalThis&{__portariaPg?:RuntimeResources};
export function getResources():RuntimeResources {
  if(!process.env.PORTO_PG_CONFIG||!process.env.PORTO_MEDIA_ROOT)throw Error('Configure PostgreSQL e o armazenamento privado antes de iniciar.');
  return globalRuntime.__portariaPg??= {
    db:new PostgresDatabase(JSON.parse(process.env.PORTO_PG_CONFIG)),
    bucket:new FileObjectStore(process.env.PORTO_MEDIA_ROOT),
    jobToken:process.env.PORTO_JOB_TOKEN,allowHttpLan:process.env.PORTO_ALLOW_HTTP_LAN==='true',
  };
}
