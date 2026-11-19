import { PostgresDatabase } from '../persistence/postgres.ts';
import { IdSecureExitGateway } from './idsecure-gateway.ts';
import type { ExitGateway } from './types.ts';
import { ExitAccessService } from './service.ts';
import { ExitAccessWorker } from './worker.ts';
export class ExitAccessRuntime {
  readonly service: ExitAccessService;
  readonly worker: ExitAccessWorker;
  constructor(db: PostgresDatabase, gateway: ExitGateway) {
    this.service = new ExitAccessService(db, gateway);
    this.worker = new ExitAccessWorker(db, gateway);
  }
  handle(...args: Parameters<ExitAccessService['handle']>) {
    return this.service.handle(...args);
  }
  restoreGuard() {
    return this.service.restoreGuard();
  }
  startWorker() {
    return this.worker.start();
  }
}
export async function loadExitAccess(db: PostgresDatabase, path: string) {
  return new ExitAccessRuntime(db, await IdSecureExitGateway.fromFile(path));
}
