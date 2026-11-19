import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handleApi } from '../lib/server.ts';
import { SqliteTestDatabase } from './support/sqlite-fixture.mjs';
import { testSession } from './fixture-auth.mjs';

test('API persiste frota/material, reaplica chave sem duplicar e protege nota fiscal e capability', async () => {
  const db = new SqliteTestDatabase(),
    origin = 'https://fixture.example';
  try {
    await handleApi(new Request(origin + '/api/session'), db);
    const sessions = Object.fromEntries(
      ['admin', 'gate', 'reader'].map((role) => {
        const cookie = testSession(db, {
          id: role,
          name: role + ' fictício',
          email: role + '@example.test',
        });
        db.sqlite
          .prepare("UPDATE operational_users SET role=?,status='active' WHERE id=?")
          .run(role, role);
        return [role, cookie];
      }),
    );
    const call = async (path, role = 'admin', body) => {
      const response = await handleApi(
        new Request(origin + '/api' + path, {
          method: body ? 'POST' : 'GET',
          headers: {
            cookie: sessions[role],
            ...(body ? { origin, 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        }),
        db,
      );
      return { status: response.status, body: await response.json() };
    };
    const command = async (type, payload, role = 'gate', key = randomUUID(), revision) =>
      call('/commands', role, {
        type,
        payload,
        idempotencyKey: key,
        revision: revision ?? (await call('/state', role)).body.revision,
      });
    const vehicle = await command('FLEET_VEHICLE_SAVE', {
      plate: 'QAT9A23',
      name: 'Veículo fictício API',
      initialOdometerKm: 100,
    });
    assert.equal(vehicle.status, 200, JSON.stringify(vehicle.body));
    const revision = (await call('/state', 'gate')).body.revision,
      key = randomUUID();
    const payload = {
      fleetId: vehicle.body.result.id,
      driver: 'Motorista QA',
      destination: 'Destino QA',
      purpose: 'Teste',
      odometerOut: 100,
    };
    const departure = await command('FLEET_DEPART', payload, 'gate', key, revision);
    assert.equal(departure.status, 200);
    const replay = await command('FLEET_DEPART', payload, 'gate', key, revision);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.result.id, departure.body.result.id);
    assert.equal((await call('/state')).body.state.fleetTrips.length, 1);
    assert.equal(
      (await command('FLEET_RETURN', { id: departure.body.result.id, odometerIn: 99 })).status,
      400,
    );
    assert.equal(
      (await command('FLEET_RETURN', { id: departure.body.result.id, odometerIn: 108 })).status,
      200,
    );
    const material = await command('MATERIAL_EXIT_CREATE', {
      description: 'Material fictício',
      quantity: '2 caixas',
      destination: 'Destino QA',
      responsible: 'Responsável QA',
      invoiceNumber: 'NF-PRIVATE-QA-448',
    });
    assert.equal(material.status, 200);
    const read = await call('/state', 'reader');
    assert.equal(read.status, 200);
    assert.equal(read.body.state.materialExits[0].invoiceNumber, undefined);
    assert.equal(JSON.stringify(read.body).includes('NF-PRIVATE-QA-448'), false);
    assert.equal(
      (
        await command(
          'FLEET_VEHICLE_SAVE',
          { plate: 'QAT8A23', name: 'Proibido', initialOdometerKm: 0 },
          'reader',
        )
      ).status,
      403,
    );
    db.sqlite
      .prepare('INSERT INTO operational_access(user_id,body) VALUES(?,?)')
      .run('gate', JSON.stringify({ incidentManage: false }));
    assert.equal(
      (
        await command('MATERIAL_EXIT_CREATE', {
          description: 'Material',
          quantity: '1',
          destination: 'QA',
          responsible: 'QA',
        })
      ).status,
      403,
    );
  } finally {
    db.sqlite.close();
  }
});
