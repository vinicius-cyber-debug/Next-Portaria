import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createNativeProcessRegistry } from '../scripts/native-process.mjs';
import {
  windowsArguments,
  nodeEntrypoint,
  inspectProcess,
  inspectLinuxProcess,
  waitForProcessExit,
  terminateProcess,
  sameProcess,
} from '../scripts/process-identity.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'portaria-process-test-')),
    path = join(root, 'runtime/process.json'),
    callbacks = [],
    signals = [],
    states = new Map();
  mkdirSync(join(root, 'runtime'));
  mkdirSync(join(root, 'scripts'));
  const identity = (pid = 701, extra = {}) => ({
    state: 'live',
    pid,
    parentPid: 1,
    startedAt: 100000,
    startId: 'birth-' + pid,
    executable: process.execPath,
    cwd: root,
    argv: [process.execPath, join(root, 'scripts/server-process.mjs')],
    ...extra,
  });
  let own = identity();
  states.set(own.pid, own);
  const registry = createNativeProcessRegistry({
    root,
    path,
    inspect: (pid) => states.get(pid) ?? { state: 'dead' },
    self: () => own,
    onExit: (callback) => callbacks.push(callback),
    terminate: (actual) => {
      signals.push(actual.pid);
      states.set(actual.pid, { state: 'dead' });
    },
  });
  const legacy = (pid = 702) => ({ pid, root, mode: 'https', port: 8443, startedAt: 1000 });
  return {
    root,
    path,
    identity,
    states,
    signals,
    callbacks,
    registry,
    legacy,
    setSelf: (actual) => {
      own = actual;
      states.set(actual.pid, actual);
    },
    save: (value) => writeFileSync(path, JSON.stringify(value)),
    text: () => readFileSync(path, 'utf8'),
    close: () => {
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
        throw Error('Fixture fora da pasta temporária.');
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('linha de comando usa argumentos exatos e rejeita eval/print e nomes parecidos', () => {
  assert.deepEqual(
    windowsArguments(
      '"C:\\Program Files\\node.exe" --import "C:\\loader with space.mjs" "C:\\app\\scripts\\server-process.mjs" "x\\\"y"',
    ),
    [
      'C:\\Program Files\\node.exe',
      '--import',
      'C:\\loader with space.mjs',
      'C:\\app\\scripts\\server-process.mjs',
      'x"y',
    ],
  );
  const root = resolve('fixture-root');
  assert.equal(
    nodeEntrypoint(['node', '--import', 'loader.mjs', 'scripts/server-process.mjs'], root),
    join(root, 'scripts/server-process.mjs'),
  );
  assert.equal(
    nodeEntrypoint(['node', '--eval=console.log("scripts/server-process.mjs")'], root),
    null,
  );
  assert.equal(nodeEntrypoint(['node', '--print=process.pid'], root), null);
  assert.equal(
    nodeEntrypoint(['node', '--unknown-option', 'scripts/server-process.mjs'], root),
    null,
  );
});

for (const platform of ['Windows', 'Linux'])
  test(
    'PID reutilizado por outro programa não bloqueia registro nem é encerrado: ' + platform,
    () => {
      const f = fixture();
      try {
        const foreign = f.identity(702, {
          startId: 'new-unrelated-process',
          startedAt: 900000,
          argv: [
            process.execPath,
            join(f.root, 'other/scripts/server-process.mjs'),
            join(f.root, 'scripts/server-process.mjs'),
          ],
        });
        if (platform === 'Windows')
          foreign.argv = windowsArguments(foreign.argv.map((arg) => '"' + arg + '"').join(' '));
        f.states.set(702, foreign);
        f.save(f.legacy());
        assert.equal(f.registry.status().state, 'foreign');
        const registered = f.registry.register('https', 8443);
        assert.equal(registered.pid, 701);
        assert.equal(f.registry.read().instanceId, registered.instanceId);
        assert.deepEqual(f.signals, []);
        f.save(f.legacy());
        assert.deepEqual(f.registry.stop(), { state: 'stale' });
        assert.equal(existsSync(f.path), false);
        assert.deepEqual(f.signals, []);
        assert.equal(f.states.get(702), foreign);
      } finally {
        f.close();
      }
    },
  );

test('registro morto é substituído; instância viva válida permanece única; parada confirma a identidade', () => {
  const f = fixture();
  try {
    f.save(f.legacy());
    assert.equal(f.registry.status().state, 'dead');
    const first = f.registry.register('https', 8443);
    const saved = f.text();
    f.setSelf(f.identity(703));
    assert.throws(() => f.registry.register('https', 8443), /Já existe/);
    assert.equal(f.text(), saved);
    assert.equal(f.registry.status().state, 'live');
    assert.deepEqual(f.registry.stop(first), { state: 'stopped' });
    assert.deepEqual(f.signals, [701]);
    assert.equal(existsSync(f.path), false);
  } finally {
    f.close();
  }
});

test('release anterior morta permite atualização; raiz diferente viva ou desconhecida é preservada', () => {
  const f = fixture();
  try {
    const previousRoot = join(f.root, 'previous-release');
    const previous = { ...f.legacy(), root: previousRoot };
    f.save(previous);
    assert.equal(f.registry.status().state, 'dead');
    assert.equal(f.registry.register('https', 8443).root, f.root);
    for (const actual of [
      f.identity(702, {
        cwd: previousRoot,
        argv: [process.execPath, join(previousRoot, 'scripts/server-process.mjs')],
      }),
      { state: 'unknown' },
    ]) {
      f.save(previous);
      f.states.set(702, actual);
      const saved = f.text();
      assert.equal(f.registry.status().state, 'unknown');
      assert.throws(() => f.registry.register('https', 8443), /identidade/);
      assert.throws(() => f.registry.stop(), /identidade/);
      assert.equal(f.text(), saved);
      assert.deepEqual(f.signals, []);
    }
    f.save({ ...previous, pid: 701 });
    assert.equal(f.registry.register('https', 8443).root, f.root);
  } finally {
    f.close();
  }
});

test('identidade indisponível, registro inválido e JSON corrompido são preservados', () => {
  const f = fixture();
  try {
    f.save(f.legacy());
    f.states.set(702, { state: 'unknown' });
    let saved = f.text();
    assert.throws(() => f.registry.register('https', 8443), /identidade/);
    assert.throws(() => f.registry.stop(), /identidade/);
    assert.equal(f.text(), saved);
    f.save({ ...f.legacy(), root: join(f.root, 'other') });
    saved = f.text();
    assert.throws(() => f.registry.register('https', 8443), /identidade/);
    assert.equal(f.text(), saved);
    writeFileSync(f.path, '{"pid":');
    saved = f.text();
    assert.throws(() => f.registry.register('https', 8443), /conferir o registro/);
    assert.throws(() => f.registry.stop(), /conferir o registro/);
    assert.equal(f.text(), saved);
    assert.deepEqual(f.signals, []);
  } finally {
    f.close();
  }
});

test('mesmo PID pode registrar a própria instância comprovada; cleanup antigo não remove a nova', () => {
  const f = fixture();
  try {
    f.save({ ...f.legacy(701), startedAt: 1 });
    const first = f.registry.register('https', 8443),
      second = f.registry.register('https', 8443);
    assert.notEqual(first.instanceId, second.instanceId);
    f.callbacks[0]();
    assert.equal(f.registry.read().instanceId, second.instanceId);
    f.registry.cleanup(first);
    assert.equal(f.registry.read().instanceId, second.instanceId);
    f.callbacks[1]();
    assert.equal(existsSync(f.path), false);
  } finally {
    f.close();
  }
});

test('mudança de nascimento do PID impede parada e sobrescrita; troca de registro preserva o substituto', () => {
  const f = fixture();
  try {
    const record = f.registry.register('https', 8443);
    f.setSelf(f.identity(703));
    f.states.set(701, f.identity(701, { startId: 'reused-pid', startedAt: 200000 }));
    const saved = f.text();
    assert.equal(f.registry.status().state, 'changed');
    assert.throws(() => f.registry.stop(), /processo mudou/);
    assert.throws(() => f.registry.register('https', 8443), /identidade/);
    assert.equal(f.text(), saved);
    assert.deepEqual(f.signals, []);
    f.save({ ...record, instanceId: 'replacement' });
    assert.throws(() => f.registry.stop(record), /registro mudou/);
    f.registry.cleanup(record);
    assert.equal(f.registry.read().instanceId, 'replacement');
  } finally {
    f.close();
  }
});

test('parada revalida antes do sinal e não apaga registro substituído durante o encerramento', () => {
  const f = fixture();
  try {
    const first = f.registry.register('https', 8443);
    f.setSelf(f.identity(703));
    let reads = 0,
      signals = 0;
    const changed = createNativeProcessRegistry({
      root: f.root,
      path: f.path,
      self: () => f.identity(703),
      inspect: (pid) =>
        pid === 701
          ? ++reads === 1
            ? f.identity(701)
            : f.identity(701, { startId: 'reused' })
          : (f.states.get(pid) ?? { state: 'dead' }),
      terminate: () => {
        signals++;
      },
    });
    assert.throws(() => changed.stop(), /processo mudou antes/);
    assert.equal(signals, 0);
    assert.equal(f.registry.read().instanceId, first.instanceId);
    const replacement = { ...first, pid: 704, startId: 'birth-704', instanceId: 'new-owner' };
    const replaced = createNativeProcessRegistry({
      root: f.root,
      path: f.path,
      self: () => f.identity(703),
      inspect: (pid) => f.states.get(pid) ?? { state: 'dead' },
      terminate: (actual) => {
        signals++;
        f.states.set(actual.pid, { state: 'dead' });
        f.save(replacement);
      },
    });
    assert.deepEqual(replaced.stop(), { state: 'stopped' });
    assert.equal(signals, 1);
    assert.deepEqual(f.registry.read(), replacement);
  } finally {
    f.close();
  }
});

test('lock morto ou PID reaproveitado é recuperado; lock vivo/desconhecido e gate órfão falham fechados', () => {
  const f = fixture();
  try {
    const lock = f.path + '.lock',
      gate = lock + '.recovery',
      claim = { pid: 702, startId: 'old', nonce: 'old-lock' };
    writeFileSync(lock, JSON.stringify(claim));
    f.registry.register('https', 8443);
    assert.equal(existsSync(lock), false);
    writeFileSync(lock, JSON.stringify(claim));
    f.states.set(702, f.identity(702, { startId: 'new' }));
    f.registry.register('https', 8443);
    assert.equal(existsSync(lock), false);
    for (const state of [{ state: 'unknown' }, f.identity(702, { startId: 'old' })]) {
      f.states.set(702, state);
      writeFileSync(lock, JSON.stringify(claim));
      const saved = f.text();
      assert.throws(() => f.registry.register('https', 8443), /outra instância/);
      assert.equal(f.text(), saved);
      assert.equal(readFileSync(lock, 'utf8'), JSON.stringify(claim));
      rmSync(lock);
    }
    writeFileSync(lock, JSON.stringify(claim));
    writeFileSync(
      gate,
      JSON.stringify({ pid: 999, startId: 'dead-owner', nonce: 'dead-recovery' }),
    );
    const saved = f.text(),
      gateText = readFileSync(gate, 'utf8');
    assert.throws(() => f.registry.register('https', 8443), /recuperação anterior/);
    assert.equal(f.text(), saved);
    assert.equal(readFileSync(gate, 'utf8'), gateText);
    assert.equal(readFileSync(lock, 'utf8'), JSON.stringify(claim));
  } finally {
    f.close();
  }
});

test('inspeção real identifica o processo atual sem depender só do PID', () => {
  const actual = inspectProcess(process.pid);
  assert.equal(actual.state, 'live');
  assert.equal(actual.pid, process.pid);
  assert.ok(actual.startId);
  assert.ok(Number.isFinite(actual.startedAt));
  assert.ok(Array.isArray(actual.argv));
  assert.ok(actual.argv.length > 1);
  assert.ok(sameProcess(actual, inspectProcess(process.pid)));
  const different = { ...actual, startId: actual.startId + '-changed' };
  let signalled = false;
  assert.throws(
    () =>
      terminateProcess(different, {
        inspect: () => actual,
        signal: () => {
          signalled = true;
        },
      }),
    /processo mudou/,
  );
  assert.equal(signalled, false);
});

test('Linux: desaparecimento de exe/cwd após stat reconhece zumbi/exiting sem confundir permissão', () => {
  const linuxStat = (state) =>
    '701 (node (fixture)) ' + [state, '11', ...Array(17).fill('0'), '12345'].join(' ');
  const failure = (code) => Object.assign(Error('fixture'), { code });
  function scenario({
    nextState = 'Z',
    firstError,
    nextError,
    fileError = 'ENOENT',
    vanishAt = 'exe',
    probeError,
  } = {}) {
    let reads = 0,
      probes = 0;
    const actual = inspectLinuxProcess(701, {
      readFile: (path) => {
        if (path === '/proc/701/stat') {
          reads++;
          if (reads === 1 && firstError) throw failure(firstError);
          if (reads > 1 && nextError) throw failure(nextError);
          return linuxStat(reads === 1 ? 'S' : nextState);
        }
        if (path === '/proc/sys/kernel/random/boot_id') return 'boot-test';
        if (path === '/proc/stat') return 'btime 1000\n';
        throw Error('Leitura inesperada: ' + path);
      },
      realpath: () => {
        if (vanishAt === 'exe') throw failure(fileError);
        return '/usr/bin/node';
      },
      readlink: () => {
        assert.equal(vanishAt, 'cwd', 'cwd não deve ser lido após exe desaparecer');
        throw failure(fileError);
      },
      ticks: () => 100,
      probe: () => {
        probes++;
        if (probeError) throw failure(probeError);
      },
    });
    return { actual, reads, probes };
  }
  for (const state of ['Z', 'X', 'x'])
    for (const vanishAt of ['exe', 'cwd']) {
      const result = scenario({ nextState: state, vanishAt });
      assert.deepEqual(result.actual, { state: 'dead' });
      assert.equal(result.reads, 2);
      assert.equal(result.probes, 0);
    }
  assert.equal(scenario({ nextState: 'S' }).actual.state, 'unknown');
  assert.equal(scenario({ fileError: 'EACCES' }).actual.state, 'unknown');
  const denied = scenario({ nextError: 'EACCES', probeError: 'ESRCH' });
  assert.equal(denied.actual.state, 'unknown');
  assert.equal(denied.probes, 0);
  assert.equal(
    scenario({ firstError: 'ENOENT', nextError: 'ENOENT', probeError: 'ESRCH' }).actual.state,
    'dead',
  );
  assert.equal(scenario({ firstError: 'ENOENT', nextError: 'ENOENT' }).actual.state, 'unknown');
});

test('confirmação aguarda unknown/argv transitório e preserva prazo e identidade sem novo sinal', () => {
  const f = fixture();
  try {
    const actual = f.identity(701);
    let clock = 0;
    const states = [{ state: 'unknown' }, { ...actual, argv: [] }, { state: 'dead' }];
    waitForProcessExit(actual, {
      inspect: () => states.shift(),
      timeoutMs: 200,
      now: () => clock,
      pause: (ms) => {
        clock += ms;
      },
    });
    assert.equal(clock, 100);
    for (const current of [{ state: 'unknown' }, { ...actual, argv: [] }]) {
      clock = 0;
      assert.throws(
        () =>
          waitForProcessExit(actual, {
            inspect: () => current,
            timeoutMs: 100,
            now: () => clock,
            pause: (ms) => {
              clock += ms;
            },
          }),
        /registro foi preservado/,
      );
      assert.equal(clock, 100);
    }
    waitForProcessExit(actual, {
      inspect: () => ({ ...actual, startId: 'new-process' }),
      pause: () => assert.fail('PID de nascimento diferente não exige outro sinal ou espera'),
    });
    assert.deepEqual(f.signals, []);
  } finally {
    f.close();
  }
});

test('parada com inspeção unknown após SIGTERM confirma saída depois e envia um único sinal', () => {
  const f = fixture();
  try {
    const record = f.registry.register('https', 8443);
    f.setSelf(f.identity(703));
    let signalled = 0,
      confirmations = 0;
    const registry = createNativeProcessRegistry({
      root: f.root,
      path: f.path,
      self: () => f.identity(703),
      inspect: (pid) =>
        pid === 701 && signalled
          ? ++confirmations < 3
            ? { state: 'unknown' }
            : { state: 'dead' }
          : (f.states.get(pid) ?? { state: 'dead' }),
      terminate: () => {
        signalled++;
      },
    });
    assert.deepEqual(registry.stop(record), { state: 'stopped' });
    assert.equal(signalled, 1);
    assert.equal(confirmations, 3);
    assert.equal(existsSync(f.path), false);
  } finally {
    f.close();
  }
});

async function startChild(script, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    windowsHide: true,
    cwd: dirnameOf(script),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr.on('data', (d) => (errors += d));
  const message = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(Error('Fixture não respondeu: ' + errors)), 30000);
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once('message', (value) => {
      clearTimeout(timer);
      done(value);
    });
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        fail(Error('Fixture encerrou: ' + code + ' ' + errors));
      }
    });
  });
  return { child, message };
}
function dirnameOf(path) {
  return resolve(path, '..');
}
async function closeChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((done) => child.once('exit', done));
  child.send('quit');
  await closed;
}

test(
  'fixture Node real mantém instância única, não encerra PID alheio e confirma parada e cleanup',
  { timeout: 90000 },
  async () => {
    const f = fixture();
    let foreign, owned, normal;
    try {
      const registryModule = pathToFileURL(resolve('scripts/native-process.mjs')).href,
        script = join(f.root, 'scripts/server-process.mjs'),
        alien = join(f.root, 'scripts/alien-server-process.mjs');
      writeFileSync(
        script,
        `import {createNativeProcessRegistry} from ${JSON.stringify(registryModule)};const registry=createNativeProcessRegistry({root:process.argv[2],path:process.argv[3]});try{const record=registry.register('https',8443);process.send({state:'ready',pid:process.pid,record});process.on('message',m=>{if(m==='quit')process.exit(0);});}catch(error){process.send({state:'error',message:error.message});process.exitCode=1;}\n`,
      );
      writeFileSync(
        alien,
        "process.send({state:'ready',pid:process.pid});process.on('message',m=>{if(m==='quit')process.exit(0);});\n",
      );
      foreign = (await startChild(alien)).child;
      f.save(f.legacy(foreign.pid));
      const first = await startChild(script, [f.root, f.path]);
      owned = first.child;
      assert.equal(first.message.state, 'ready');
      assert.doesNotThrow(() => process.kill(foreign.pid, 0));
      const duplicate = await startChild(script, [f.root, f.path]);
      assert.equal(duplicate.message.state, 'error');
      assert.match(duplicate.message.message, /Já existe/);
      assert.equal(JSON.parse(f.text()).pid, owned.pid);
      const live = createNativeProcessRegistry({ root: f.root, path: f.path }),
        exited = new Promise((done) => owned.once('exit', done));
      assert.deepEqual(live.stop(), { state: 'stopped' });
      await exited;
      assert.equal(existsSync(f.path), false);
      assert.doesNotThrow(() => process.kill(foreign.pid, 0));
      const clean = await startChild(script, [f.root, f.path]);
      normal = clean.child;
      assert.equal(clean.message.state, 'ready');
      await closeChild(normal);
      assert.equal(existsSync(f.path), false);
    } finally {
      for (const child of [normal, owned, foreign]) if (child) await closeChild(child);
      f.close();
    }
  },
);
