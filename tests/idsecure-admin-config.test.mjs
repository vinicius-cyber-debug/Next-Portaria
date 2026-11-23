import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { IdSecureAdminConfig } from '../lib/integrations/admin-config.ts';
import { handleApi } from '../lib/server.ts';
import { centralFixture } from './support/idsecure-central-fixture.mjs';
import { hasPostgres, withPostgresFixture } from './support/postgres-fixture.mjs';

const admin = { id: 'admin-qa', name: 'Administrador QA', role: 'admin', status: 'active' };
const context = { user: admin, authorize: async () => admin };
async function call(service, method = 'GET', input, ctx = context, path = '/api/admin/controlid') {
  const response = await service.handle(
    new Request('https://fixture.example' + path, {
      method,
      headers: input === undefined ? {} : { 'content-type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    }),
    ctx,
  );
  const body = await response.json();
  return { response, status: response.status, body };
}

test(
  'editor Control iD valida e preserva conexão, auditoria e isolamento, sem comandos físicos',
  { skip: !hasPostgres, timeout: 90000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'portaria-admin-controlid-'));
    let central;
    try {
      await mkdir(join(home, 'central'));
      central = await centralFixture(join(home, 'central'));
      await withPostgresFixture(async ({ db, owner }) => {
        await handleApi(new Request('http://127.0.0.1/api/session'), db);
        const path = join(home, 'permanent', 'idsecure.json');
        let changed = 0;
        const service = new IdSecureAdminConfig(db, path, {
          minimumIntervalMs: 0,
          onChanged: () => {
            changed++;
          },
        });
        const initial = await call(service);
        const input = {
          origin: central.credentials.origin,
          username: central.credentials.username,
          password: central.credentials.password,
          certificatePem: central.tls.ca.toString('utf8'),
          sourceId: central.credentials.sourceId,
          version: initial.body.version,
        };

        await t.test(
          'GET é seguro e acesso não administrativo é recusado sem tocar a rede',
          async () => {
            assert.equal(initial.status, 200);
            assert.equal(initial.body.configured, false);
            assert.equal(initial.body.hardwareWritesEnabled, false);
            assert.equal(initial.response.headers.get('cache-control'), 'no-store, private');
            assert.equal(
              (
                await call(service, 'GET', undefined, {
                  user: { ...admin, role: 'gate' },
                  authorize: async () => admin,
                })
              ).status,
              403,
            );
            assert.equal(
              (
                await call(service, 'GET', undefined, {
                  user: admin,
                  authorize: async () => ({ ...admin, role: 'reader' }),
                })
              ).status,
              403,
            );
            assert.equal(central.requests.length, 0);
          },
        );

        await t.test(
          'destinos públicos, HTTP, chaves privadas e campos internos são recusados antes da rede',
          async () => {
            for (const extra of [
              { origin: 'https://example.com' },
              { origin: 'http://127.0.0.1:30443' },
              { origin: 'https://user:secret@192.168.1.2:30443' },
              { origin: 'https://192.168.1.2:30443/path' },
              { password: input.username },
              { certificatePem: input.certificatePem + central.tls.privateKey.toString() },
              { certificatePath: 'C:/private.file' },
              { mode: 'write' },
              { certificatePem: 'x'.repeat(65537) },
            ]) {
              const result = await call(
                service,
                'POST',
                { ...input, ...extra },
                context,
                '/api/admin/controlid/test',
              );
              assert.ok([400, 413, 422].includes(result.status), JSON.stringify(result.body));
            }
            assert.equal(central.requests.length, 0);
            assert.equal((await call(service)).body.configured, false);
          },
        );

        await t.test(
          'teste somente lê e salvar cria certificado fixado e configuração permanente sem revelar segredo',
          async () => {
            const checked = await call(
              service,
              'POST',
              input,
              context,
              '/api/admin/controlid/test',
            );
            assert.equal(checked.status, 200, JSON.stringify(checked.body));
            assert.equal(checked.body.connection.status, 'connected');
            assert.equal((await call(service)).body.configured, false);
            const saved = await call(service, 'PUT', input);
            assert.equal(saved.status, 200, JSON.stringify(saved.body));
            assert.equal(saved.body.saved, true);
            assert.equal(saved.body.configured, true);
            assert.equal(saved.body.passwordConfigured, true);
            assert.equal(saved.body.mode, 'read_only');
            assert.equal(saved.body.hardwareWritesEnabled, false);
            assert.equal(changed, 1);
            const persisted = JSON.parse(await readFile(path, 'utf8'));
            assert.equal(persisted.password, input.password);
            assert.equal(persisted.sourceId, input.sourceId);
            assert.ok(persisted.certificatePath.startsWith(join(home, 'permanent') + sep));
            assert.equal(await readFile(persisted.certificatePath, 'utf8'), input.certificatePem);
            for (const result of [checked.body, saved.body, (await call(service)).body]) {
              const text = JSON.stringify(result);
              assert.ok(!text.includes(input.password));
              assert.ok(!text.includes('accessToken'));
              assert.ok(!text.includes('certificatePath'));
              assert.ok(!text.includes('PRIVATE KEY'));
            }
            const audit = (
              await owner.query(
                "SELECT body FROM operational_audit WHERE body::jsonb->>'action'='CONTROLID_CONFIG_SAVE'",
              )
            ).rows;
            assert.equal(audit.length, 1);
            assert.ok(!JSON.stringify(audit).includes(input.password));
            assert.ok(!JSON.stringify(audit).includes('BEGIN CERTIFICATE'));
            assert.equal(
              (await owner.query('SELECT count(*) AS n FROM operational_changes')).rows[0].n,
              '1',
            );
          },
        );

        await t.test(
          'campos vazios preservam senha e certificado; fonte e versão antigas não são sobrescritas',
          async () => {
            const latest = (await call(service)).body;
            const keep = await call(service, 'PUT', {
              ...input,
              password: '',
              certificatePem: '',
              version: latest.version,
            });
            assert.equal(keep.status, 200, JSON.stringify(keep.body));
            const current = await readFile(path, 'utf8');
            assert.equal(JSON.parse(current).password, input.password);
            assert.equal((await call(service, 'PUT', input)).status, 409);
            assert.equal(
              (
                await call(service, 'PUT', {
                  ...input,
                  sourceId: 'different-central',
                  version: keep.body.version,
                })
              ).status,
              400,
            );
            assert.equal(await readFile(path, 'utf8'), current);
          },
        );

        await t.test(
          'credencial recusada não altera arquivo e erros não reproduzem conteúdo da central',
          async () => {
            const current = await readFile(path, 'utf8');
            central.state.loginStatus = 401;
            const latest = (await call(service)).body;
            const result = await call(service, 'PUT', {
              ...input,
              password: 'fixture-refused-password',
              version: latest.version,
            });
            central.state.loginStatus = 200;
            assert.equal(result.status, 422);
            assert.equal(result.body.error.code, 'CONTROLID_AUTHENTICATION');
            assert.equal(result.body.error.httpStatus, 401);
            assert.equal(result.body.error.phase, 'authentication');
            assert.ok(!JSON.stringify(result.body).includes('fixture-refused-password'));
            assert.equal(await readFile(path, 'utf8'), current);
          },
        );

        await t.test('revogação depois da leitura/teste impede resposta ou gravação', async () => {
          let checks = 0;
          const latest = (await call(service)).body,
            before = await readFile(path, 'utf8');
          const revoked = {
            user: admin,
            authorize: async () => (++checks >= 2 ? { ...admin, role: 'reader' } : admin),
          };
          assert.equal(
            (
              await call(
                service,
                'POST',
                { ...input, version: latest.version },
                revoked,
                '/api/admin/controlid/test',
              )
            ).status,
            403,
          );
          checks = 0;
          assert.equal(
            (await call(service, 'PUT', { ...input, version: latest.version }, revoked)).status,
            403,
          );
          assert.equal(await readFile(path, 'utf8'), before);
        });

        await t.test(
          'falha de auditoria conserva a configuração anterior e nenhuma senha vai à base',
          async () => {
            await owner.query(
              "CREATE FUNCTION reject_controlid_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body::jsonb->>'action'='CONTROLID_CONFIG_SAVE' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_controlid_audit BEFORE INSERT ON operational_audit FOR EACH ROW EXECUTE FUNCTION reject_controlid_audit();",
            );
            const latest = (await call(service)).body,
              before = await readFile(path, 'utf8');
            const result = await call(service, 'PUT', {
              ...input,
              password: 'fixture-rotated-password',
              version: latest.version,
            });
            assert.equal(result.status, 500);
            assert.equal(await readFile(path, 'utf8'), before);
            assert.equal(
              (
                await owner.query(
                  "SELECT count(*) AS n FROM operational_audit WHERE body LIKE '%fixture-rotated-password%'",
                )
              ).rows[0].n,
              '0',
            );
            await owner.query(
              'DROP TRIGGER reject_controlid_audit ON operational_audit; DROP FUNCTION reject_controlid_audit();',
            );
          },
        );

        await t.test(
          'certificado ausente e senha insegura existente podem ser reparados sem expor credenciais',
          async () => {
            const previous = JSON.parse(await readFile(path, 'utf8'));
            await writeFile(
              path,
              JSON.stringify({
                ...previous,
                password: previous.username,
                certificatePath: join(home, 'not-present.pem'),
              }),
            );
            const broken = await call(service);
            assert.equal(broken.status, 200);
            assert.equal(broken.body.certificateValid, false);
            assert.equal(broken.body.passwordConfigured, true);
            const repaired = await call(service, 'PUT', {
              ...input,
              password: 'fixture-secure-replacement',
              version: broken.body.version,
            });
            assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
            assert.equal(repaired.body.certificateValid, true);
          },
        );

        await t.test('PEM vazio nunca substitui silenciosamente o pin existente', async () => {
          const original = await readFile(path, 'utf8');
          const inconsistent = JSON.stringify({
            ...JSON.parse(original),
            fingerprint256: Array(32).fill('00').join(':'),
          });
          await writeFile(path, inconsistent);
          const count = central.requests.length;
          try {
            const latest = (await call(service)).body;
            assert.equal(latest.certificateValid, false);
            for (const certificatePem of ['', undefined]) {
              const result = await call(
                service,
                'POST',
                { ...input, password: '', certificatePem, version: latest.version },
                context,
                '/api/admin/controlid/test',
              );
              assert.ok([400, 409, 422].includes(result.status), JSON.stringify(result.body));
            }
            assert.equal(central.requests.length, count);
            assert.equal(await readFile(path, 'utf8'), inconsistent);
          } finally {
            await writeFile(path, original);
          }
        });

        await t.test(
          'alterar origem ou usuário exige senha explícita antes de enviar credencial antiga',
          async () => {
            let requests = 0;
            const protectedService = new IdSecureAdminConfig(db, path, {
              minimumIntervalMs: 0,
              createConnection: () => ({
                async call() {
                  requests++;
                },
              }),
            });
            const latest = (await call(protectedService)).body,
              original = await readFile(path, 'utf8');
            for (const change of [
              { origin: 'https://192.168.50.254:30443' },
              { username: 'different-user' },
            ]) {
              for (const password of ['', undefined]) {
                const result = await call(
                  protectedService,
                  'POST',
                  { ...input, ...change, password, version: latest.version },
                  context,
                  '/api/admin/controlid/test',
                );
                assert.equal(result.status, 400, JSON.stringify(result.body));
              }
            }
            assert.equal(requests, 0);
            assert.equal(await readFile(path, 'utf8'), original);
          },
        );

        await t.test(
          'configuração compartilhada com gateway ativo fica somente para consulta',
          async () => {
            let requests = 0;
            const protectedService = new IdSecureAdminConfig(db, path, {
              minimumIntervalMs: 0,
              canEdit: () => false,
              createConnection: () => ({
                async call() {
                  requests++;
                },
              }),
            });
            const latest = await call(protectedService),
              original = await readFile(path, 'utf8');
            assert.equal(latest.status, 200);
            assert.equal(latest.body.editable, false);
            for (const [method, route] of [
              ['POST', '/api/admin/controlid/test'],
              ['PUT', '/api/admin/controlid'],
            ]) {
              const result = await call(
                protectedService,
                method,
                { ...input, version: latest.body.version },
                context,
                route,
              );
              assert.equal(result.status, 409);
              assert.equal(result.body.error.code, 'CONTROLID_MANAGED_EXTERNALLY');
            }
            assert.equal(requests, 0);
            assert.equal(await readFile(path, 'utf8'), original);
          },
        );

        await t.test(
          'gateway ativado durante o teste impede persistir uma configuração concorrente',
          async () => {
            let editable = true;
            const protectedService = new IdSecureAdminConfig(db, path, {
              minimumIntervalMs: 0,
              canEdit: () => editable,
              createConnection: () => ({
                async call() {
                  editable = false;
                },
              }),
            });
            const latest = (await call(protectedService)).body,
              original = await readFile(path, 'utf8');
            const result = await call(protectedService, 'PUT', {
              ...input,
              password: '',
              certificatePem: '',
              version: latest.version,
            });
            assert.equal(result.status, 409);
            assert.equal(result.body.error.code, 'CONTROLID_MANAGED_EXTERNALLY');
            assert.equal(await readFile(path, 'utf8'), original);
          },
        );

        await t.test(
          'CAS preserva atualização externa ocorrida durante o teste de rede',
          async () => {
            let release;
            const entered = new Promise((done) => {
              release = done;
            });
            let continueTest;
            const blocker = new Promise((done) => {
              continueTest = done;
            });
            const concurrent = new IdSecureAdminConfig(db, path, {
              minimumIntervalMs: 0,
              createConnection: () => ({
                async call() {
                  release();
                  await blocker;
                },
              }),
            });
            const latest = (await call(concurrent)).body;
            const pending = call(concurrent, 'PUT', {
              ...input,
              password: '',
              certificatePem: '',
              version: latest.version,
            });
            await entered;
            const original = JSON.parse(await readFile(path, 'utf8'));
            const external = JSON.stringify({
              ...original,
              username: 'qa-external-user',
              password: 'qa-external-password',
            });
            await writeFile(path, external);
            continueTest();
            assert.equal((await pending).status, 409);
            assert.equal(await readFile(path, 'utf8'), external);
          },
        );

        await t.test(
          'instância recusa tempestade de testes e edição indisponível é explícita',
          async () => {
            let clock = Date.now();
            const limited = new IdSecureAdminConfig(db, path, { now: () => clock });
            const latest = (await call(limited)).body;
            assert.equal(
              (
                await call(
                  limited,
                  'POST',
                  {
                    ...input,
                    password: '',
                    certificatePem: '',
                    username: latest.username,
                    version: latest.version,
                  },
                  context,
                  '/api/admin/controlid/test',
                )
              ).status,
              200,
            );
            const blocked = await call(
              limited,
              'POST',
              { ...input, version: latest.version },
              context,
              '/api/admin/controlid/test',
            );
            assert.equal(blocked.status, 429);
            assert.equal(blocked.response.headers.get('retry-after'), '3');
            clock += 3000;
            assert.equal(
              (
                await call(
                  limited,
                  'POST',
                  {
                    ...input,
                    password: '',
                    certificatePem: '',
                    username: latest.username,
                    version: latest.version,
                  },
                  context,
                  '/api/admin/controlid/test',
                )
              ).status,
              200,
            );
            const unavailable = new IdSecureAdminConfig(db, null);
            assert.equal((await call(unavailable)).body.supported, false);
            assert.equal((await call(unavailable, 'PUT', input)).status, 503);
          },
        );

        assert.ok(central.requests.length > 0);
        assert.ok(
          central.requests.every(
            (request) => request.method === 'GET' && request.path === '/api/util/configUI',
          ),
        );
        assert.equal(central.rules.size, 0);
      });
    } finally {
      await central?.close();
      if (!resolve(home).startsWith(resolve(tmpdir()) + sep))
        throw Error('Diretório QA fora da área temporária.');
      await rm(home, { recursive: true, force: true });
    }
  },
);
