import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadApplicationEnvironment, projectRoot } from './postgres-config.mjs';
import { inspectNativeProcess, stopNativeProcess } from './native-process.mjs';
const action = process.argv[2] ?? 'start',
  provider = loadApplicationEnvironment();
function invoke(script, args = []) {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(projectRoot, script), ...args],
    { cwd: projectRoot, stdio: 'inherit', windowsHide: true },
  );
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 1;
}
try {
  if (provider !== 'postgres')
    invoke('scripts/local-service.mjs', [action === 'backup' ? 'backup' : action]);
  else if (action === 'start')
    invoke('scripts/run-framework.mjs', ['start', '--hostname', '127.0.0.1', '--port', '5180']);
  else if (action === 'backup') invoke('scripts/backup-postgres.mjs', ['create', '--offline']);
  else if (action === 'status') {
    const state = inspectNativeProcess(),
      record = state.record;
    console.log(
      JSON.stringify({
        provider,
        status:
          state.state === 'live'
            ? 'running'
            : ['unknown', 'changed'].includes(state.state)
              ? 'unknown'
              : 'stopped',
        identity: state.state,
        port: record?.port ?? 5180,
        pid: record?.pid ?? null,
      }),
    );
  } else if (action === 'stop') {
    const result = stopNativeProcess();
    console.log(
      result.state === 'missing'
        ? 'A aplicação não possui processo registrado.'
        : result.state === 'stale'
          ? 'Registro antigo removido; nenhum processo alheio foi encerrado.'
          : 'Aplicação encerrada; o PostgreSQL permanece como processo separado.',
    );
  } else throw Error('Use start, stop, status ou backup.');
} catch (error) {
  console.error('ERRO:', error.message);
  process.exitCode = 1;
}
