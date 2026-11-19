import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, execute, validateState } from '../lib/domain.mjs';
import { handleApi, readSnapshot } from '../lib/server.ts';
import { stateDelta, syncState } from '../lib/state-sync.ts';
import { buildLogisticsDemo, seedLogisticsDemo } from '../scripts/seed-logistics-demo.mjs';
import { hasPostgres, withPostgresFixture } from './support/postgres-fixture.mjs';

test('simulação é aditiva, valida o histórico e recusa colisão de placa', () => {
  const before = execute(
    createInitialState(),
    {
      type: 'MASTER_SAVE',
      payload: { kind: 'fleet', record: { plate: 'REA1A01', name: 'Cadastro anterior' } },
      at: new Date().toISOString(),
    },
    { id: 'previous', name: 'Operador anterior', role: 'admin' },
  ).state;
  const original = JSON.stringify(before),
    built = buildLogisticsDemo(before);
  assert.equal(JSON.stringify(before), original);
  assert.equal(built.state.fleet.length, 4);
  assert.deepEqual(
    built.state.fleet.find((record) => record.plate === 'REA1A01'),
    before.fleet[0],
  );
  assert.equal(built.state.fleetTrips.filter((trip) => trip.status === 'out').length, 2);
  assert.equal(built.state.fleetTrips.filter((trip) => trip.status === 'returned').length, 3);
  assert.equal(
    built.state.fleetTrips.reduce((sum, trip) => sum + (trip.distanceKm ?? 0), 0),
    138,
  );
  assert.equal(built.state.materialExits.length, 6);
  assert.equal(built.state.materialExits.filter((item) => item.invoiceNumber).length, 5);
  assert.deepEqual(built.state.people, before.people);
  assert.deepEqual(built.state.settings, before.settings);
  validateState(built.state);
  assert.equal(stateDelta(before, built.state).collections.materialExits.upsert.length, 6);
  assert.throws(() => buildLogisticsDemo(built.state), /placa reservada/);
});

test(
  'carga PostgreSQL é atômica, concorrente e idempotente, com revisão, auditoria e sync',
  { skip: !hasPostgres },
  async () => {
    await withPostgresFixture(async ({ db, owner }) => {
      await handleApi(new Request('http://127.0.0.1/api/session'), db);
      const before = await readSnapshot(db);
      const results = await Promise.all([seedLogisticsDemo(db), seedLogisticsDemo(db)]);
      assert.equal(results.filter((result) => result.replayed).length, 1);
      const after = await readSnapshot(db);
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.state.fleet.length, 3);
      assert.equal(after.state.fleetTrips.length, 5);
      assert.equal(after.state.materialExits.length, 6);
      assert.equal(after.state.audit.length - before.state.audit.length, 17);
      assert.equal(
        (await owner.query('SELECT count(*) AS n FROM operational_users')).rows[0].n,
        '0',
      );
      const delta = await syncState(
        db,
        { id: 'reader', role: 'reader', status: 'active', capabilities: {} },
        before.revision,
      );
      assert.equal(delta.delta.collections.materialExits.upsert.length, 6);
      assert.ok(
        delta.delta.collections.materialExits.upsert.every(
          (item) => !Object.hasOwn(item, 'invoiceNumber'),
        ),
      );
      assert.equal(delta.delta.collections.audit, undefined);
      validateState(after.state);
    });
  },
);
