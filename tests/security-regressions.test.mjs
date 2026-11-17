import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { handleApi } from '../lib/server.ts';
import { SqliteTestDatabase, MemoryObjectStore } from './support/sqlite-fixture.mjs';
import { hasPostgres, withPostgresFixture } from './support/postgres-fixture.mjs';

const origin = 'http://127.0.0.1:5199';
async function exercise(db, t) {
  const bucket = new MemoryObjectStore(),
    cookies = {},
    now = new Date().toISOString();
  async function call(path, actor = 'admin', method = 'GET', body) {
    const response = await handleApi(
      new Request(origin + '/api' + path, {
        method,
        headers: {
          cookie: cookies[actor] ?? '',
          ...(method === 'GET' ? {} : { origin }),
          ...(body instanceof FormData ? {} : body ? { 'content-type': 'application/json' } : {}),
        },
        body:
          body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      }),
      db,
      { bucket },
    );
    return { status: response.status, body: await response.json() };
  }
  await call('/session');
  for (const role of ['admin', 'gate', 'director']) {
    const token = randomBytes(32).toString('hex');
    cookies[role] = 'porto_session=' + token;
    await db
      .prepare(
        'INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .bind(role, role + '@example.test', role + ' QA', role, 'active', now, now)
      .run();
    await db
      .prepare(
        'INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at,must_change_password) VALUES(?,?,?,?,?,?,0)',
      )
      .bind(role, role, '0'.repeat(32), '0'.repeat(64), 310000, now)
      .run();
    await db
      .prepare(
        'INSERT INTO operational_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)',
      )
      .bind(
        createHash('sha256').update(token).digest('hex'),
        role,
        now,
        new Date(Date.now() + 3600000).toISOString(),
      )
      .run();
  }
  async function command(type, payload, actor = 'admin') {
    const snapshot = await call('/state', actor);
    return call('/commands', actor, 'POST', {
      type,
      payload,
      revision: snapshot.body.revision,
      idempotencyKey: randomUUID(),
    });
  }
  await t.test(
    'portaria não transforma funcionário em visitante nem amplia autoridade por override',
    async () => {
      const employee = await command('MASTER_SAVE', {
        kind: 'people',
        record: {
          name: 'Funcionario ficticio QA',
          company: 'Empresa QA',
          category: 'employee',
          securityStatus: 'cleared',
        },
      });
      assert.equal(employee.status, 200);
      const personId = employee.body.result.id;
      const jpeg = Uint8Array.from([
          255, 216, 255, 192, 0, 17, 8, 1, 224, 2, 128, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217,
        ]),
        form = new FormData();
      form.set('file', new File([jpeg], 'foto-qa.jpg', { type: 'image/jpeg' }));
      const photo = await call('/visitor-photos', 'gate', 'POST', form);
      assert.equal(photo.status, 200);
      const payload = {
        personId,
        purpose: 'Teste de segregacao',
        host: 'Contato QA',
        expectedAt: now,
        validUntil: new Date(Date.now() + 3600000).toISOString(),
        identityConfirmed: true,
        photoAttachmentId: photo.body.attachment.id,
      };
      assert.equal((await command('VISITOR_GATE_REGISTER', payload, 'gate')).status, 403);
      for (const category of ['visitor', 'driver', 'supplier', 'contractor'])
        assert.equal(
          (
            await command(
              'MASTER_SAVE',
              { kind: 'people', record: { id: personId, category } },
              'gate',
            )
          ).status,
          403,
        );
      await db
        .prepare('INSERT INTO operational_access(user_id,body) VALUES(?,?)')
        .bind('gate', JSON.stringify({ accessManage: true }))
        .run();
      assert.equal(
        (
          await command(
            'MASTER_SAVE',
            { kind: 'people', record: { id: personId, category: 'visitor' } },
            'gate',
          )
        ).status,
        403,
      );
      assert.equal((await command('VISITOR_GATE_REGISTER', payload, 'gate')).status, 403);
      assert.equal(
        (await call('/state')).body.state.people.find((p) => p.id === personId).category,
        'employee',
      );
      assert.equal(
        (
          await command(
            'MASTER_SAVE',
            { kind: 'people', record: { id: personId, name: 'Nome revisado QA' } },
            'gate',
          )
        ).status,
        200,
      );
      await db
        .prepare('INSERT INTO operational_access(user_id,body) VALUES(?,?)')
        .bind('director', JSON.stringify({ accessManage: false }))
        .run();
      assert.equal(
        (
          await command(
            'MASTER_SAVE',
            { kind: 'people', record: { id: personId, category: 'visitor' } },
            'director',
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await command('MASTER_SAVE', {
            kind: 'people',
            record: { id: personId, category: 'visitor' },
          })
        ).status,
        200,
      );
      const pending = await command(
        'MASTER_SAVE',
        { kind: 'people', record: { id: personId, category: 'contractor' } },
        'gate',
      );
      assert.equal(pending.status, 200);
      const contractor = (await call('/state')).body.state.people.find((p) => p.id === personId);
      assert.equal(contractor.securityStatus, 'pending');
      assert.equal(
        (
          await command(
            'MASTER_SAVE',
            { kind: 'people', record: { id: personId, category: 'visitor' } },
            'gate',
          )
        ).status,
        403,
      );
    },
  );
  await t.test(
    'snapshot, histórico e sincronização ocultam a mesma mídia sem documentView',
    async () => {
      await db
        .prepare('UPDATE operational_access SET body=? WHERE user_id=?')
        .bind(JSON.stringify({ documentView: false, auditView: true }), 'director')
        .run();
      const before = (await call('/state', 'director')).body.revision;
      const events = ['media', 'attachment', 'visitor'].map((entity, index) => ({
        id: 'regression-audit-' + index,
        at: now,
        actor: 'admin QA',
        actorId: 'admin',
        role: 'admin',
        action: entity === 'visitor' ? 'VISITOR_REQUEST' : 'MEDIA_UPLOAD_START',
        entity,
        entityId: 'qa-' + index,
        detail:
          entity === 'visitor'
            ? 'Evento publico QA'
            : JSON.stringify({ name: 'arquivo-confidencial-QA.mp4' }),
        changes: [],
      }));
      for (const event of events)
        await db
          .prepare('INSERT INTO operational_audit(id,at,body) VALUES(?,?,?)')
          .bind(event.id, now, JSON.stringify(event))
          .run();
      await db.prepare('UPDATE operational_meta SET revision=revision+1 WHERE id=1').run();
      await db
        .prepare('INSERT INTO operational_changes(revision,created_at,body) VALUES(?,?,?)')
        .bind(
          before + 1,
          now,
          JSON.stringify({ collections: { audit: { upsert: events, remove: [] } }, values: {} }),
        )
        .run();
      for (const path of ['/state', '/records?collection=audit', '/sync?since=' + before]) {
        const result = await call(path, 'director');
        assert.equal(result.status, 200);
        assert.doesNotMatch(JSON.stringify(result.body), /arquivo-confidencial-QA/);
        assert.match(JSON.stringify(result.body), /Evento publico QA/);
      }
      assert.match(
        JSON.stringify((await call('/records?collection=audit')).body),
        /arquivo-confidencial-QA/,
      );
      await db
        .prepare('UPDATE operational_access SET body=? WHERE user_id=?')
        .bind(JSON.stringify({ documentView: true, auditView: false }), 'director')
        .run();
      assert.deepEqual((await call('/state', 'director')).body.state.audit, []);
      assert.equal((await call('/records?collection=audit', 'director')).status, 403);
      const delta = (await call('/sync?since=' + before, 'director')).body;
      assert.equal(delta.delta.collections.audit, undefined);
      assert.doesNotMatch(JSON.stringify(delta), /Evento publico QA|arquivo-confidencial-QA/);
    },
  );
}
test('segurança da autorização e auditoria no SQLite isolado', async (t) => {
  const db = new SqliteTestDatabase();
  try {
    await exercise(db, t);
  } finally {
    db.close();
  }
});
test(
  'segurança da autorização e auditoria no PostgreSQL real',
  { skip: !hasPostgres, timeout: 60000 },
  async (t) => withPostgresFixture(async ({ db }) => exercise(db, t)),
);
