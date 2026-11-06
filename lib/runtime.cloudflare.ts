import {env} from 'cloudflare:workers';
import type {RuntimeResources} from './persistence/contracts.ts';
export function getResources():RuntimeResources {
  return {db:env.DB,bucket:env.BUCKET,jobToken:env.PORTO_JOB_TOKEN,allowHttpLan:env.PORTO_ALLOW_HTTP_LAN==='true'} as unknown as RuntimeResources;
}
