import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../lib/server.ts';
import { testSession } from './fixture-auth.mjs';
import { SqliteTestDatabase } from './support/sqlite-fixture.mjs';

test('configuração Control iD exige administrador, sessão, HTTPS e origem válida antes do serviço', async () => {
  const db = new SqliteTestDatabase(),
    origin = 'https://fixture.example';
  try {
    await handleApi(new Request(origin + '/api/session'), db);
    const cookies = {};
    for (const role of ['admin', 'gate', 'director', 'operations', 'reader']) {
      cookies[role] = testSession(db, {
        id: role,
        name: role + ' QA',
        email: role + '@example.test',
      });
      db.sqlite
        .prepare("UPDATE operational_users SET status='active',role=? WHERE id=?")
        .run(role, role);
    }
    let calls = 0;
    const resources = {
      controlId: {
        async handle(request, context) {
          calls++;
          await context.authorize(db);
          return Response.json({ supported: true, configured: false });
        },
      },
    };
    const call = (role, method = 'GET', endpoint = origin, source = endpoint) =>
      handleApi(
        new Request(endpoint + '/api/admin/controlid', {
          method,
          headers: {
            ...(role ? { cookie: cookies[role] } : {}),
            ...(method === 'GET' ? {} : { origin: source, 'content-type': 'application/json' }),
          },
          body: method === 'GET' ? undefined : '{}',
        }),
        db,
        resources,
      );
    assert.equal((await call(null)).status, 401);
    for (const role of ['gate', 'director', 'operations', 'reader']) {
      assert.equal((await call(role)).status, 403);
      assert.equal((await call(role, 'PUT')).status, 403);
    }
    assert.equal((await call('admin', 'PUT', origin, 'https://other.example')).status, 403);
    assert.equal((await call('admin', 'PUT', 'http://192.168.1.20')).status, 403);
    const insecure = await handleApi(
      new Request('http://192.168.1.20/api/admin/controlid', {
        method: 'PUT',
        headers: {
          cookie: cookies.admin,
          origin: 'http://192.168.1.20',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
      db,
      { ...resources, allowHttpLan: true },
    );
    assert.equal(insecure.status, 403);
    assert.equal(calls, 0);
    assert.equal((await call('admin')).status, 200);
    assert.equal((await call('admin', 'PUT')).status, 200);
    assert.equal(calls, 2);
    const absent = await handleApi(
      new Request(origin + '/api/admin/controlid', { headers: { cookie: cookies.admin } }),
      db,
    );
    assert.deepEqual(await absent.json(), { supported: false, configured: false });
  } finally {
    db.sqlite.close();
  }
});

test('revalidação administrativa recusa papel alterado durante operação da conexão', async () => {
  const db = new SqliteTestDatabase(),
    origin = 'https://fixture.example';
  try {
    await handleApi(new Request(origin + '/api/session'), db);
    const cookie = testSession(db, { id: 'admin', name: 'Admin QA', email: 'admin@example.test' });
    testSession(db, { id: 'backup-admin', name: 'Outro admin QA', email: 'backup@example.test' });
    db.sqlite
      .prepare("UPDATE operational_users SET role='admin',status='active' WHERE id='backup-admin'")
      .run();
    let reached = false;
    const controlId = {
      async handle(request, context) {
        db.sqlite.prepare("UPDATE operational_users SET role='reader' WHERE id='admin'").run();
        await context.authorize(db);
        reached = true;
        return Response.json({ ok: true });
      },
    };
    const response = await handleApi(
      new Request(origin + '/api/admin/controlid/test', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: '{}',
      }),
      db,
      { controlId },
    );
    assert.equal(response.status, 403);
    assert.equal(reached, false);
  } finally {
    db.sqlite.close();
  }
});
