import { PostgresDatabase } from './persistence/postgres.ts';
import { FileObjectStore } from './storage/filesystem.ts';
import type { RuntimeResources } from './persistence/contracts.ts';
import { MediaService } from './media.ts';
import { PortoService } from './porto/service.ts';
import { IdSecureMonitor } from './integrations/monitor.ts';
import { ExitAccessRuntime } from './exit-access/runtime.ts';
import {
  DisabledExitGateway,
  IdSecureExitGateway,
  validateExitGatewayConfig,
} from './exit-access/idsecure-gateway.ts';
import { IdSecureHttp } from './integrations/idsecure-http.ts';
import { readFileSync } from 'node:fs';
const globalRuntime = globalThis as typeof globalThis & { __portariaPg?: RuntimeResources };
export function getResources(): RuntimeResources {
  if (!process.env.PORTO_PG_CONFIG || !process.env.PORTO_MEDIA_ROOT)
    throw Error('Configure PostgreSQL e o armazenamento privado antes de iniciar.');
  if (globalRuntime.__portariaPg) return globalRuntime.__portariaPg;
  const db = new PostgresDatabase(JSON.parse(process.env.PORTO_PG_CONFIG)),
    bucket = new FileObjectStore(process.env.PORTO_MEDIA_ROOT);
  let gateway: import('./exit-access/types.ts').ExitGateway = new DisabledExitGateway();
  if (process.env.PORTO_EXIT_CONFIG) {
    try {
      const config = validateExitGatewayConfig(
        JSON.parse(readFileSync(process.env.PORTO_EXIT_CONFIG, 'utf8')),
      );
      if (config.enabled) {
        const credentials = JSON.parse(readFileSync(config.credentialFile, 'utf8'));
        gateway = new IdSecureExitGateway(
          config,
          new IdSecureHttp(credentials, readFileSync(credentials.certificatePath, 'utf8')),
        );
      }
    } catch {
      gateway = new DisabledExitGateway('configuration_invalid');
      console.error('Integração de saída desativada: revise a configuração e o certificado.');
    }
  }
  return (globalRuntime.__portariaPg = {
    db,
    deploymentStage:
      process.env.PORTO_DEPLOYMENT_STAGE === 'homologation'
        ? 'homologation'
        : process.env.PORTO_DEPLOYMENT_STAGE === 'production'
          ? 'production'
          : undefined,
    bucket,
    media: new MediaService(db, bucket),
    porto: new PortoService(db, process.env.PORTO_PORTO_ENABLED === 'true'),
    monitor: new IdSecureMonitor(db, process.env.PORTO_IDSECURE_CONFIG ?? ''),
    exitAccess: new ExitAccessRuntime(db, gateway),
    jobToken: process.env.PORTO_JOB_TOKEN,
    allowHttpLan: process.env.PORTO_ALLOW_HTTP_LAN === 'true',
  });
}
