import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  hashPassword,
  verifyPassword,
  PASSWORD_ITERATIONS,
  LEGACY_PASSWORD_ITERATIONS,
} from '../lib/local-auth.ts';
import { handleApi } from '../lib/server.ts';
import { SqliteTestDatabase } from './support/sqlite-fixture.mjs';
import { hasPostgres, waitUntil, withPostgresFixture } from './support/postgres-fixture.mjs';

const origin = 'http://127.0.0.1:5199';
const password = 'Senha-legada-QA-123!';
const nextPassword = 'Nova!823';
const loginRead = /SELECT c\.user_id AS id/;
const passwordRead = /SELECT password_salt AS salt/;
const legacy = () => {
  const salt = randomBytes(16).toString('hex');
  return {
    salt,
    hash: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 310_000, 32, 'sha256').toString('hex'),
    iterations: 310_000,
  };
};

// Intercept completed reads while preserving the real statement instances used
// by PostgreSQL batch transactions. No test mutates the operational database.
function interceptReads(db) {
  const prepare = db.prepare.bind(db);
  let hook;
  db.prepare = (sql) => {
    function decorate(statement) {
      const first = statement.first.bind(statement),
        bind = statement.bind.bind(statement);
      statement.first = async (...args) => {
        const result = await first(...args);
        if (hook?.match.test(sql)) {
          const callback = hook.callback;
          if (hook.once) hook = null;
          await callback(result);
        }
        return result;
      };
      statement.bind = (...params) => decorate(bind(...params));
      return statement;
    }
    return decorate(prepare(sql));
  };
  return (match, callback, once = true) => {
    hook = { match, callback, once };
  };
}

async function exercise(db, t, rejectSessionInsert, sessionFailureStatus = 500) {
  const setReadHook = interceptReads(db);
  const run = (sql, ...params) =>
    db
      .prepare(sql)
      .bind(...params)
      .run();
  const first = (sql, ...params) =>
    db
      .prepare(sql)
      .bind(...params)
      .first();
  async function call(path, body, cookie) {
    const response = await handleApi(
      new Request(origin + '/api' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      db,
    );
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }
  await call('/session');
  async function account() {
    const id = 'qa_' + randomUUID().replaceAll('-', ''),
      credential = legacy(),
      now = new Date().toISOString();
    await run(
      "INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES(?,?,?,'gate','active',?,?)",
      id,
      id + '@example.test',
      'Conta fictícia de teste',
      now,
      now,
    );
    await run(
      'INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at,must_change_password) VALUES(?,?,?,?,?,?,0)',
      id,
      id,
      credential.salt,
      credential.hash,
      credential.iterations,
      now,
    );
    return { id, credential, now };
  }
  const stored = (id) =>
    first(
      'SELECT password_salt,password_hash,password_iterations,password_changed_at,failed_attempts,locked_until FROM operational_credentials WHERE user_id=?',
      id,
    );
  const sessions = async (id) =>
    Number((await first('SELECT count(*) AS n FROM operational_sessions WHERE user_id=?', id)).n);
  const login = (id, secret = password) => call('/auth/login', { username: id, password: secret });
  async function cookie(id) {
    const token = randomBytes(32).toString('hex'),
      now = new Date().toISOString();
    await run(
      'INSERT INTO operational_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)',
      createHash('sha256').update(token).digest('hex'),
      id,
      now,
      new Date(Date.now() + 3600000).toISOString(),
    );
    return 'porto_session=' + token;
  }

  await t.test(
    'login legado migra uma vez, mantém a idade da senha e não expõe o hash',
    async () => {
      const a = await account(),
        existingCookie = await cookie(a.id);
      await run('UPDATE operational_credentials SET must_change_password=1 WHERE user_id=?', a.id);
      const revision = await first('SELECT revision FROM operational_meta WHERE id=1');
      const audit = await first('SELECT count(*) AS n FROM operational_audit');
      const signed = await login(a.id);
      assert.equal(signed.status, 200);
      assert.ok(signed.cookie);
      assert.equal(signed.body.mustChangePassword, true);
      const previousSession = await call('/session', undefined, existingCookie);
      assert.equal(previousSession.status, 200);
      assert.equal(previousSession.body.user.mustChangePassword, true);
      const migrated = await stored(a.id);
      assert.equal(migrated.password_iterations, 600000);
      assert.notEqual(migrated.password_salt, a.credential.salt);
      assert.equal(migrated.password_changed_at, a.now);
      assert.equal(
        await verifyPassword(
          password,
          migrated.password_salt,
          migrated.password_hash,
          migrated.password_iterations,
        ),
        true,
      );
      assert.equal(JSON.stringify(signed).includes(migrated.password_hash), false);
      assert.equal((await login(a.id)).status, 200);
      assert.deepEqual(await stored(a.id), migrated);
      assert.equal(await sessions(a.id), 3);
      assert.deepEqual(await first('SELECT revision FROM operational_meta WHERE id=1'), revision);
      assert.deepEqual(await first('SELECT count(*) AS n FROM operational_audit'), audit);
    },
  );
  await t.test('senha errada não migra o hash legado; custo inválido é recusado', async () => {
    const a = await account();
    assert.equal((await login(a.id, 'senha-errada-QA')).status, 401);
    let value = await stored(a.id);
    assert.equal(value.password_hash, a.credential.hash);
    assert.equal(value.password_iterations, 310000);
    assert.equal(value.failed_attempts, 1);
    await run(
      'UPDATE operational_credentials SET password_iterations=? WHERE user_id=?',
      2147483647,
      a.id,
    );
    assert.equal((await login(a.id)).status, 401);
    value = await stored(a.id);
    assert.equal(value.password_iterations, 2147483647);
    assert.equal(await sessions(a.id), 0);
  });
  await t.test('conta desativada não migra a credencial mesmo com a senha correta', async () => {
    const a = await account();
    await run("UPDATE operational_users SET status='disabled' WHERE id=?", a.id);
    const signed = await login(a.id);
    assert.equal(signed.status, 403);
    assert.equal(signed.cookie, undefined);
    assert.equal((await stored(a.id)).password_hash, a.credential.hash);
    assert.equal((await stored(a.id)).password_iterations, 310000);
    assert.equal(await sessions(a.id), 0);
  });
  await t.test(
    'reset concorrente preserva a nova senha e não cria sessão para a antiga',
    async () => {
      const a = await account(),
        reset = await hashPassword(nextPassword);
      setReadHook(loginRead, () =>
        run(
          'UPDATE operational_credentials SET password_salt=?,password_hash=?,password_iterations=? WHERE user_id=?',
          reset.salt,
          reset.hash,
          reset.iterations,
          a.id,
        ),
      );
      const signed = await login(a.id);
      assert.equal(signed.status, 401);
      assert.equal(signed.cookie, undefined);
      assert.equal(await sessions(a.id), 0);
      assert.equal((await stored(a.id)).password_hash, reset.hash);
      assert.equal((await login(a.id, nextPassword)).status, 200);
    },
  );
  await t.test('bloqueio concorrente não é apagado pela migração', async () => {
    const a = await account(),
      locked = new Date(Date.now() + 900000).toISOString();
    setReadHook(loginRead, () =>
      run(
        'UPDATE operational_credentials SET failed_attempts=5,locked_until=? WHERE user_id=?',
        locked,
        a.id,
      ),
    );
    assert.equal((await login(a.id)).status, 401);
    const value = await stored(a.id);
    assert.equal(value.password_iterations, 310000);
    assert.equal(value.locked_until, locked);
    assert.equal(value.failed_attempts, 5);
    assert.equal(await sessions(a.id), 0);
    assert.equal((await login(a.id)).status, 429);
  });
  await t.test(
    'desativação e mudança concorrente no cadastro impedem sessão e rehash',
    async () => {
      for (const status of ['disabled', 'active']) {
        const a = await account(),
          changed = new Date(Date.now() + 1000).toISOString();
        setReadHook(loginRead, () =>
          run(
            'UPDATE operational_users SET status=?,updated_at=? WHERE id=?',
            status,
            changed,
            a.id,
          ),
        );
        assert.equal((await login(a.id)).status, 401);
        assert.equal((await stored(a.id)).password_iterations, 310000);
        assert.equal(await sessions(a.id), 0);
      }
    },
  );
  await t.test(
    'dois logins legados concorrentes não sobrescrevem a migração vencedora',
    async () => {
      const a = await account();
      let count = 0,
        release;
      const gate = new Promise((done) => {
        release = done;
      });
      setReadHook(
        loginRead,
        async () => {
          count++;
          if (count === 2) {
            setReadHook(/never-match/, () => {});
            release();
          }
          await gate;
        },
        false,
      );
      const results = await Promise.all([login(a.id), login(a.id)]);
      assert.equal(results.filter((r) => r.status === 200).length, 1);
      const rejected = results.find((r) => r.status !== 200);
      assert.ok([401, 409].includes(rejected.status));
      assert.equal(rejected.cookie, undefined);
      const value = await stored(a.id);
      assert.equal(value.password_iterations, 600000);
      assert.equal(
        await verifyPassword(
          password,
          value.password_salt,
          value.password_hash,
          value.password_iterations,
        ),
        true,
      );
      assert.equal(await sessions(a.id), 1);
    },
  );
  await t.test(
    'falha ao inserir sessão reverte a atualização do hash na mesma transação',
    async () => {
      const a = await account();
      await rejectSessionInsert(a.id);
      const result = await login(a.id);
      assert.equal(result.status, sessionFailureStatus);
      assert.equal(result.cookie, undefined);
      const value = await stored(a.id);
      assert.equal(value.password_hash, a.credential.hash);
      assert.equal(value.password_iterations, 310000);
      assert.equal(await sessions(a.id), 0);
    },
  );
  await t.test(
    'troca de senha aceita reautenticação legada e grava somente o custo atual',
    async () => {
      const a = await account(),
        oldCookie = await cookie(a.id);
      const changed = await call(
        '/auth/change-password',
        { currentPassword: password, newPassword: nextPassword },
        oldCookie,
      );
      assert.equal(changed.status, 200);
      assert.ok(changed.cookie);
      assert.equal((await stored(a.id)).password_iterations, 600000);
      assert.equal((await call('/session', undefined, oldCookie)).status, 401);
      assert.equal((await login(a.id, nextPassword)).status, 200);
    },
  );
  await t.test(
    'revogação de sessão ou bloqueio durante a reautenticação não troca a senha',
    async () => {
      for (const mutation of ['session', 'lock']) {
        const a = await account(),
          oldCookie = await cookie(a.id);
        setReadHook(passwordRead, () =>
          mutation === 'session'
            ? run('DELETE FROM operational_sessions WHERE user_id=?', a.id)
            : run(
                'UPDATE operational_credentials SET failed_attempts=5,locked_until=? WHERE user_id=?',
                new Date(Date.now() + 900000).toISOString(),
                a.id,
              ),
        );
        const changed = await call(
          '/auth/change-password',
          { currentPassword: password, newPassword: nextPassword },
          oldCookie,
        );
        assert.equal(changed.status, 403);
        assert.equal(changed.cookie, undefined);
        assert.equal((await stored(a.id)).password_hash, a.credential.hash);
        assert.equal((await stored(a.id)).password_iterations, 310000);
      }
    },
  );
}

test('PBKDF2 permite somente os custos atual e legado e mantém mínimo de oito caracteres', async () => {
  assert.equal(PASSWORD_ITERATIONS, 600000);
  assert.equal(LEGACY_PASSWORD_ITERATIONS, 310000);
  const current = await hashPassword('Porto!82'),
    previous = legacy();
  assert.equal(current.iterations, 600000);
  assert.equal(await verifyPassword('Porto!82', current.salt, current.hash, 600000), true);
  assert.equal(await verifyPassword(password, previous.salt, previous.hash, 310000), true);
  for (const cost of [0, 1, -1, 310001, 600001, 2 ** 31 - 1, Infinity, NaN, '600000', null])
    assert.equal(await verifyPassword(password, previous.salt, previous.hash, cost), false);
});

test('migração de hash e concorrência na API SQLite isolada', async (t) => {
  const db = new SqliteTestDatabase();
  try {
    await exercise(
      db,
      t,
      async (id) =>
        db.sqlite.exec(
          `CREATE TRIGGER qa_session_failure BEFORE INSERT ON operational_sessions WHEN NEW.user_id='${id}' BEGIN SELECT RAISE(ABORT,'QA_SESSION_FAILURE'); END;`,
        ),
      400,
    );
  } finally {
    db.close();
  }
});

test(
  'migração de hash e concorrência na API PostgreSQL isolada',
  { skip: !hasPostgres, timeout: 120000 },
  async (t) => {
    await withPostgresFixture(async ({ db, owner, database }) => {
      await exercise(db, t, async (id) =>
        owner.query(
          `CREATE FUNCTION qa_session_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${id}' THEN RAISE EXCEPTION 'QA_SESSION_FAILURE'; END IF; RETURN NEW; END; $$; CREATE TRIGGER qa_session_failure BEFORE INSERT ON operational_sessions FOR EACH ROW EXECUTE FUNCTION qa_session_failure();`,
        ),
      );
      await t.test(
        'login aguarda a mutação administrativa e não revive a sessão revogada',
        async () => {
          const id = 'race_' + randomUUID().replaceAll('-', ''),
            credential = legacy(),
            reset = await hashPassword(nextPassword),
            now = new Date().toISOString();
          await owner.query(
            "INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES($1,$2,'Conta fictícia','gate','active',$3,$3)",
            [id, id + '@example.test', now],
          );
          await owner.query(
            'INSERT INTO operational_credentials(user_id,username,password_salt,password_hash,password_iterations,password_changed_at,must_change_password) VALUES($1,$1,$2,$3,$4,$5,0)',
            [id, credential.salt, credential.hash, credential.iterations, now],
          );
          const administrator = await owner.connect();
          let open = false,
            signed,
            settled = false;
          try {
            // Open the administrative transaction only after initialization and
            // the old credential read, so the wait occurs at the login commit.
            const setLoginHook = interceptReads(db);
            setLoginHook(loginRead, async () => {
              await administrator.query('BEGIN');
              open = true;
              await administrator.query('SELECT id FROM operational_meta WHERE id=1 FOR UPDATE');
              await administrator.query(
                'UPDATE operational_credentials SET password_salt=$1,password_hash=$2,password_iterations=$3,password_changed_at=$4 WHERE user_id=$5',
                [
                  reset.salt,
                  reset.hash,
                  reset.iterations,
                  new Date(Date.now() + 1000).toISOString(),
                  id,
                ],
              );
              await administrator.query('DELETE FROM operational_sessions WHERE user_id=$1', [id]);
              await administrator.query(
                'UPDATE operational_meta SET revision=revision+1 WHERE id=1',
              );
            });
            signed = handleApi(
              new Request(origin + '/api/auth/login', {
                method: 'POST',
                headers: { origin, 'content-type': 'application/json' },
                body: JSON.stringify({ username: id, password }),
              }),
              db,
            ).then((response) => {
              settled = true;
              return response;
            });
            await waitUntil(
              async () =>
                Boolean(
                  (
                    await owner.query(
                      "SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE operational_meta SET revision=revision%' ",
                      [database],
                    )
                  ).rowCount,
                ),
              'O login não aguardou o bloqueio compartilhado.',
              15000,
            );
            assert.equal(settled, false);
            await administrator.query('COMMIT');
            open = false;
            const response = await signed;
            assert.ok([401, 409].includes(response.status));
            assert.equal(response.headers.get('set-cookie'), null);
            const stored = (
              await owner.query(
                'SELECT password_hash,password_iterations FROM operational_credentials WHERE user_id=$1',
                [id],
              )
            ).rows[0];
            assert.equal(stored.password_hash, reset.hash);
            assert.equal(stored.password_iterations, 600000);
            assert.equal(
              Number(
                (
                  await owner.query(
                    'SELECT count(*) AS n FROM operational_sessions WHERE user_id=$1',
                    [id],
                  )
                ).rows[0].n,
              ),
              0,
            );
          } finally {
            if (open) await administrator.query('ROLLBACK');
            administrator.release();
            if (signed) await signed;
          }
        },
      );
    });
  },
);
