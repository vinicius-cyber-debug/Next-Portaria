import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  openSync,
  closeSync,
  renameSync,
} from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectRoot } from './postgres-config.mjs';
import {
  canonicalPath,
  inspectProcess,
  nodeEntrypoint,
  nodeExecutable,
  sameProcess,
  terminateProcess,
} from './process-identity.mjs';
export const nativeProcessPath =
  process.env.PORTO_NATIVE_PROCESS_FILE ?? join(projectRoot, '.porto-runtime/native-process.json');

function read(path) {
  try {
    const text = readFileSync(path, 'utf8');
    return { text, value: JSON.parse(text) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Error(
      'Não foi possível conferir o registro de processo. Nenhum registro foi substituído.',
    );
  }
}
function valid(record) {
  return (
    record &&
    [undefined, 2].includes(record.version) &&
    typeof record.root === 'string' &&
    isAbsolute(record.root) &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    ['https', 'start', 'dev'].includes(record.mode) &&
    Number.isSafeInteger(record.port) &&
    record.port > 0 &&
    record.port <= 65535 &&
    Number.isFinite(record.startedAt)
  );
}
function entry(root, mode) {
  return join(root, 'scripts', mode === 'https' ? 'server-process.mjs' : 'run-framework.mjs');
}

export function createNativeProcessRegistry({
  path = nativeProcessPath,
  root = projectRoot,
  inspect = inspectProcess,
  terminate = terminateProcess,
  self = () => inspect(process.pid),
  onExit = (callback) => process.once('exit', callback),
} = {}) {
  path = resolve(path);
  root = resolve(root);
  function classify(record) {
    if (!valid(record)) return { state: 'unknown' };
    const actual = inspect(record.pid);
    if (actual.state !== 'live') return actual;
    // A stopped release can leave its record in the permanent data directory.
    // A live process from a different release still requires explicit review.
    if (canonicalPath(record.root) !== canonicalPath(root)) return { state: 'unknown', actual };
    if (!nodeExecutable(actual.executable)) return { state: 'foreign', actual };
    const actualEntry = nodeEntrypoint(actual.argv, actual.cwd ?? record.cwd ?? record.root);
    if (!actualEntry)
      return {
        state: actual.argv?.some(
          (arg) =>
            ['-e', '--eval', '-p', '--print', '-'].includes(arg) ||
            arg.startsWith('--eval=') ||
            arg.startsWith('--print='),
        )
          ? 'foreign'
          : 'unknown',
        actual,
      };
    const ourEntries = [entry(root, 'https'), entry(root, 'start')].map((value) =>
      canonicalPath(value),
    );
    if (!ourEntries.includes(canonicalPath(actualEntry))) return { state: 'foreign', actual };
    if (canonicalPath(actualEntry) !== canonicalPath(entry(root, record.mode)))
      return { state: 'changed', actual };
    if (record.version === 2) {
      if (!record.instanceId || !record.startId || !record.executable || !record.entrypoint)
        return { state: 'unknown', actual };
      if (
        record.startId !== actual.startId ||
        record.startedAt !== actual.startedAt ||
        canonicalPath(record.executable) !== canonicalPath(actual.executable) ||
        canonicalPath(record.entrypoint) !== canonicalPath(actualEntry) ||
        JSON.stringify(record.argv) !== JSON.stringify(actual.argv)
      )
        return { state: 'changed', actual };
    } else if (Math.abs(actual.startedAt - record.startedAt) > 1000)
      return { state: 'changed', actual };
    return { state: 'live', actual };
  }
  function withLock(operation) {
    mkdirSync(dirname(path), { recursive: true });
    const lock = path + '.lock',
      recovery = lock + '.recovery',
      owner = self();
    if (
      owner.state !== 'live' ||
      typeof owner.startId !== 'string' ||
      !owner.startId ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    )
      throw Error('Não foi possível confirmar a identidade deste processo.');
    const claim = { pid: owner.pid, startId: owner.startId, nonce: randomUUID() };
    let handle;
    try {
      handle = openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let recoveryHandle;
      try {
        try {
          recoveryHandle = openSync(recovery, 'wx', 0o600);
        } catch (recoveryError) {
          if (recoveryError.code === 'EEXIST')
            throw Error(
              'Uma recuperação anterior do registro não foi concluída. O operador deve conferir os processos e o bloqueio antes de removê-lo; nenhum registro foi alterado.',
            );
          throw recoveryError;
        }
        writeFileSync(recoveryHandle, JSON.stringify(claim));
        const old = read(lock);
        if (old) {
          if (
            !old.value ||
            !Number.isSafeInteger(old.value.pid) ||
            typeof old.value.startId !== 'string' ||
            typeof old.value.nonce !== 'string'
          )
            throw Error('O bloqueio de processo não pôde ser conferido.');
          const actual = inspect(old.value.pid);
          if (
            actual.state === 'unknown' ||
            (actual.state === 'live' && actual.startId === old.value.startId)
          )
            throw Error(
              'O registro de processo está sendo conferido por outra instância. Tente novamente.',
            );
          if (read(lock)?.text !== old.text) throw Error('O bloqueio mudou durante a conferência.');
          rmSync(lock);
        }
        handle = openSync(lock, 'wx', 0o600);
      } finally {
        if (recoveryHandle !== undefined) {
          closeSync(recoveryHandle);
          if (read(recovery)?.value.nonce === claim.nonce) rmSync(recovery);
        }
      }
    }
    try {
      writeFileSync(handle, JSON.stringify(claim));
      return operation();
    } finally {
      closeSync(handle);
      if (read(lock)?.value.nonce === claim.nonce) rmSync(lock);
    }
  }
  function removeIfSame(snapshot) {
    if (read(path)?.text === snapshot.text) rmSync(path);
  }
  return {
    path,
    read() {
      return read(path)?.value ?? null;
    },
    status() {
      const snapshot = read(path);
      return snapshot
        ? { ...classify(snapshot.value), record: snapshot.value }
        : { state: 'missing', record: null };
    },
    register(mode, port) {
      return withLock(() => {
        if (
          !['https', 'start', 'dev'].includes(mode) ||
          !Number.isSafeInteger(port) ||
          port < 1 ||
          port > 65535
        )
          throw Error('Modo ou porta inválidos.');
        const actual = self(),
          script = entry(root, mode),
          actualEntry = nodeEntrypoint(actual.argv, actual.cwd ?? process.cwd());
        if (
          actual.state !== 'live' ||
          !Number.isSafeInteger(actual.pid) ||
          actual.pid <= 0 ||
          typeof actual.startId !== 'string' ||
          !actual.startId ||
          !Number.isFinite(actual.startedAt) ||
          !nodeExecutable(actual.executable) ||
          !actualEntry ||
          canonicalPath(actualEntry) !== canonicalPath(script)
        )
          throw Error('O comando atual não corresponde ao iniciador desta aplicação.');
        const old = read(path);
        if (old) {
          const status = classify(old.value),
            ownProcess = sameProcess(status.actual, actual);
          if (status.state === 'live' && !ownProcess)
            throw Error(
              'Já existe uma aplicação desta cópia em execução. Use npm run stop primeiro.',
            );
          if (!['dead', 'foreign'].includes(status.state) && !ownProcess)
            throw Error(
              'A identidade do processo registrado não pôde ser confirmada. Nenhum registro foi substituído.',
            );
        }
        const record = {
          version: 2,
          pid: actual.pid,
          root,
          mode,
          port,
          startedAt: actual.startedAt,
          startId: actual.startId,
          executable: actual.executable,
          entrypoint: script,
          cwd: actual.cwd ?? process.cwd(),
          argv: actual.argv,
          instanceId: randomUUID(),
        };
        const text = JSON.stringify(record),
          temporary = path + '.' + record.instanceId + '.tmp';
        try {
          writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
          renameSync(temporary, path);
        } finally {
          try {
            rmSync(temporary, { force: true });
          } catch {
            /* unfinished temporary file remains private */
          }
        }
        const snapshot = { text, value: record };
        onExit(() => {
          try {
            withLock(() => removeIfSame(snapshot));
          } catch {
            /* never remove a replacement or unknown record at exit */
          }
        });
        return record;
      });
    },
    cleanup(record) {
      return withLock(() => {
        if (record.version !== 2 || !record.instanceId) return;
        const snapshot = read(path);
        if (
          snapshot &&
          snapshot.value.instanceId === record.instanceId &&
          snapshot.value.pid === record.pid &&
          snapshot.value.startId === record.startId
        )
          removeIfSame(snapshot);
      });
    },
    stop(expected) {
      return withLock(() => {
        const snapshot = read(path);
        if (!snapshot) return { state: 'missing' };
        if (expected && JSON.stringify(snapshot.value) !== JSON.stringify(expected))
          throw Error('O registro mudou antes da parada. Nenhum registro foi removido.');
        const status = classify(snapshot.value);
        if (['unknown', 'changed'].includes(status.state))
          throw Error(
            'O processo mudou ou sua identidade está indisponível. Nenhum processo desconhecido foi encerrado.',
          );
        if (status.state === 'live') {
          const fresh = classify(snapshot.value);
          if (fresh.state !== 'live' || !sameProcess(status.actual, fresh.actual))
            throw Error('O processo mudou antes da parada.');
          terminate(fresh.actual);
          const limit = Date.now() + 12000;
          while (true) {
            const current = inspect(fresh.actual.pid);
            if (
              current.state === 'dead' ||
              (current.state === 'live' && !sameProcess(fresh.actual, current))
            )
              break;
            if (current.state === 'unknown' || Date.now() > limit)
              throw Error(
                'Não foi possível confirmar o encerramento da aplicação. O registro foi preservado.',
              );
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          }
        }
        removeIfSame(snapshot);
        return { state: status.state === 'live' ? 'stopped' : 'stale' };
      });
    },
  };
}
const registry = createNativeProcessRegistry();
export function readNativeProcess() {
  try {
    return registry.read();
  } catch {
    return null;
  }
}
export function inspectNativeProcess() {
  return registry.status();
}
export function registerNativeProcess(mode, port) {
  return registry.register(mode, port);
}
export function stopNativeProcess() {
  const initial = registry.status();
  if (initial.state === 'missing') return { state: 'missing' };
  if (initial.state === 'live' && initial.record.mode === 'https') {
    const ui = createNativeProcessRegistry({ path: nativeProcessPath + '.ui' }),
      child = ui.status();
    if (['unknown', 'changed'].includes(child.state))
      throw Error('A identidade do processo de interface não pôde ser confirmada.');
    if (
      child.state === 'live' &&
      (child.actual.parentPid !== initial.record.pid ||
        child.actual.startedAt < initial.actual.startedAt)
    )
      throw Error('O processo da interface não pertence à aplicação registrada.');
    if (child.state !== 'missing') ui.stop(child.record);
  }
  return registry.stop(initial.record);
}
