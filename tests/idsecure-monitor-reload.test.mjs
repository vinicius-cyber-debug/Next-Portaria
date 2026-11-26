import assert from 'node:assert/strict';
import test from 'node:test';
import { IdSecureMonitor } from '../lib/integrations/monitor.ts';
import { IntegrationError } from '../lib/integrations/contracts.ts';
import { SqliteTestDatabase } from './support/sqlite-fixture.mjs';

const user = {
  id: 'qa',
  name: 'QA',
  role: 'admin',
  status: 'active',
  capabilities: { documentView: true },
};
const raw = (id, name) => ({
  idLog: id,
  idDevice: '9',
  idUser: '101',
  device: 'Catraca fictícia',
  area: 'Área QA',
  name,
  eventCode: 7,
  eventName: 'Autorizado',
  time: new Date().toISOString(),
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const request = () => new Request('https://fixture.example/api/integrations/idsecure/monitor');
const context = { user, authorize: async () => user };
const read = async (monitor) => (await monitor.handle(request(), context)).json();
function insertPerson(db, sourceId, suffix) {
  db.sqlite
    .prepare('INSERT INTO operational_records(collection,id,body) VALUES(?,?,?)')
    .run(
      'people',
      'person-' + suffix,
      JSON.stringify({
        id: 'person-' + suffix,
        name: 'Pessoa ' + suffix,
        directory: { sourceId, recordId: '101' },
        directoryPhoto: { sha256: suffix.repeat(64) },
      }),
    );
}

test('invalidação descarta credencial e espera de autenticação, permitindo consulta imediata', async () => {
  const db = new SqliteTestDatabase();
  let loads = 0;
  let current = {
    sourceId: 'old',
    async readMonitor() {
      throw new IntegrationError('authentication');
    },
  };
  const monitor = new IdSecureMonitor(db, 'unused', async () => {
    loads++;
    return current;
  });
  try {
    assert.equal((await read(monitor)).status, 'authentication');
    assert.ok(monitor.nextAttempt > Date.now() + 59000);
    current = {
      sourceId: 'new',
      async readMonitor() {
        return [raw('2', 'Nova origem')];
      },
    };
    monitor.invalidateConfiguration();
    assert.equal(monitor.reader, undefined);
    assert.equal(monitor.lastSuccessAt, null);
    assert.equal(monitor.nextAttempt, 0);
    const result = await read(monitor);
    assert.equal(loads, 2);
    assert.equal(result.status, 'connected');
    assert.equal(result.events[0].name, 'Nova origem');
  } finally {
    db.sqlite.close();
  }
});

test('resposta antiga em voo não reaparece nem desfaz a consulta compartilhada da nova configuração', async () => {
  const db = new SqliteTestDatabase(),
    oldRead = deferred(),
    oldStarted = deferred(),
    newRead = deferred(),
    newStarted = deferred();
  let newCalls = 0;
  let current = {
    sourceId: 'old',
    async readMonitor() {
      oldStarted.resolve();
      return oldRead.promise;
    },
  };
  const monitor = new IdSecureMonitor(db, 'unused', async () => current);
  try {
    insertPerson(db, 'old', 'a');
    insertPerson(db, 'new', 'b');
    const obsolete = read(monitor);
    await oldStarted.promise;
    current = {
      sourceId: 'new',
      async readMonitor() {
        newCalls++;
        newStarted.resolve();
        return newRead.promise;
      },
    };
    monitor.invalidateConfiguration();
    const fresh = read(monitor);
    await newStarted.promise;
    oldRead.resolve([raw('1', 'Pessoa antiga')]);
    const obsoleteResult = await obsolete;
    assert.deepEqual(obsoleteResult.events, []);
    assert.equal(obsoleteResult.lastSuccessAt, null);
    const shared = read(monitor);
    await Promise.resolve();
    assert.equal(newCalls, 1);
    newRead.resolve([raw('2', 'Pessoa nova')]);
    const results = await Promise.all([fresh, shared]);
    assert.ok(results.every((result) => result.status === 'connected'));
    assert.ok(results.every((result) => result.events[0].personId === 'person-b'));
    assert.ok(results.every((result) => result.events[0].photoUrl.includes('person-b')));
    assert.doesNotMatch(JSON.stringify(results), /Pessoa antiga|person-a/);
    await read(monitor);
    assert.equal(newCalls, 1);
  } finally {
    db.sqlite.close();
  }
});

test('falha antiga não altera o status, credencial ou intervalo da nova configuração', async () => {
  const db = new SqliteTestDatabase(),
    oldRead = deferred(),
    oldStarted = deferred();
  let current = {
    sourceId: 'old',
    async readMonitor() {
      oldStarted.resolve();
      return oldRead.promise;
    },
  };
  const monitor = new IdSecureMonitor(db, 'unused', async () => current);
  try {
    const obsolete = read(monitor);
    await oldStarted.promise;
    current = {
      sourceId: 'new',
      async readMonitor() {
        return [raw('2', 'Nova origem')];
      },
    };
    monitor.invalidateConfiguration();
    const fresh = await read(monitor);
    const reader = monitor.reader,
      nextAttempt = monitor.nextAttempt;
    oldRead.reject(new IntegrationError('authentication'));
    const result = await obsolete;
    assert.equal(result.status, 'connected');
    assert.deepEqual(result.events, fresh.events);
    assert.equal(monitor.reader, reader);
    assert.equal(monitor.nextAttempt, nextAttempt);
    assert.ok(monitor.nextAttempt < Date.now() + 4000);
  } finally {
    db.sqlite.close();
  }
});

test('troca de origem durante consulta de foto não mistura identidade e mídia antigas', async () => {
  const db = new SqliteTestDatabase(),
    lookupStarted = deferred(),
    lookup = deferred();
  let block = true;
  const delayedDb = {
    prepare(sql) {
      return {
        bind(...params) {
          const statement = db.prepare(sql).bind(...params);
          return {
            async all() {
              if (block) {
                block = false;
                lookupStarted.resolve();
                await lookup.promise;
              }
              return statement.all();
            },
          };
        },
      };
    },
  };
  let current = {
    sourceId: 'old',
    async readMonitor() {
      return [raw('1', 'Antiga')];
    },
  };
  const monitor = new IdSecureMonitor(delayedDb, 'unused', async () => current);
  try {
    insertPerson(db, 'old', 'a');
    insertPerson(db, 'new', 'b');
    const obsolete = read(monitor);
    await lookupStarted.promise;
    current = {
      sourceId: 'new',
      async readMonitor() {
        return [raw('2', 'Nova')];
      },
    };
    monitor.invalidateConfiguration();
    const fresh = await read(monitor);
    assert.equal(fresh.events[0].personId, 'person-b');
    lookup.resolve();
    const result = await obsolete;
    assert.deepEqual(result.events, []);
    assert.doesNotMatch(JSON.stringify(result), /person-a|Pessoa a/);
  } finally {
    lookup.resolve();
    db.sqlite.close();
  }
});
