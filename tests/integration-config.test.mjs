import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { testCertificate } from './support/idsecure-central-fixture.mjs';
import { preserveIdSecureConfig } from '../scripts/preserve-idsecure-config.mjs';
import {
  withIntegrationConfigLock,
  replaceIntegrationJson,
} from '../scripts/integration-config-files.mjs';
import { configuredIdSecurePath, loadApplicationEnvironment } from '../scripts/postgres-config.mjs';
import { integrationConfigPaths } from '../lib/integrations/config-paths.mjs';

test('conexão permanente iDSecure: upgrade offline e perfis isolados', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'portaria-connection-config-')),
    tls = await testCertificate(base);
  async function fixture(name) {
    const home = join(base, name),
      previousRoot = join(home, 'old-release'),
      releaseRoot = join(home, 'new-release'),
      dataRoot = join(home, 'data'),
      runtime = join(previousRoot, '.porto-runtime'),
      directory = join(dataRoot, 'integrations');
    for (const path of [runtime, join(releaseRoot, '.porto-runtime'), dataRoot])
      await mkdir(path, { recursive: true });
    const cert = join(runtime, 'trusted.pem');
    await writeFile(cert, tls.ca);
    const value = {
      origin: 'https://192.168.50.20:30443',
      sourceId: 'qa-central',
      username: 'qa-user',
      password: 'qa-fixture-only-password',
      mode: 'read_only',
      fingerprint256: new X509Certificate(tls.ca).fingerprint256,
      certificatePath: cert,
    };
    const legacy = join(runtime, 'idsecure.json'),
      destination = join(directory, 'idsecure.json'),
      exit = join(directory, 'exit-access.json');
    await writeFile(legacy, JSON.stringify(value));
    return {
      home,
      previousRoot,
      releaseRoot,
      dataRoot,
      runtime,
      directory,
      cert,
      value,
      legacy,
      destination,
      exit,
    };
  }
  const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
  try {
    await t.test(
      'upgrade copia certificado e retargeta gateway sem ativá-lo; independe da release antiga',
      async () => {
        const f = await fixture('upgrade');
        await mkdir(f.directory);
        await writeFile(
          f.exit,
          JSON.stringify({
            version: 1,
            enabled: false,
            credentialFile: f.legacy,
            target: { sourceId: f.value.sourceId },
          }),
        );
        const result = await preserveIdSecureConfig(f);
        assert.equal(result.idsecure, 'migrated');
        const config = await read(f.destination);
        assert.equal(config.password, f.value.password);
        assert.equal(config.fingerprint256, f.value.fingerprint256);
        assert.ok(config.certificatePath.startsWith(f.directory + sep));
        assert.deepEqual(await readFile(config.certificatePath), tls.ca);
        assert.equal((await read(f.exit)).enabled, false);
        assert.equal((await read(f.exit)).credentialFile, f.destination);
        assert.deepEqual(await read(f.legacy), f.value);
        const newer = { ...config, password: 'qa-password-rotated-later' };
        await writeFile(f.destination, JSON.stringify(newer));
        assert.ok(resolve(f.previousRoot).startsWith(resolve(base) + sep));
        await rm(f.previousRoot, { recursive: true, force: true });
        await preserveIdSecureConfig(f);
        assert.deepEqual(await read(f.destination), newer);
        assert.deepEqual(await readFile(newer.certificatePath), tls.ca);
      },
    );
    for (const relative of ['trusted.pem', '.porto-runtime/trusted.pem'])
      await t.test('preserva certificado relativo ' + relative, async () => {
        const f = await fixture(relative.startsWith('.') ? 'relative-root' : 'relative-config');
        await writeFile(f.legacy, JSON.stringify({ ...f.value, certificatePath: relative }));
        await preserveIdSecureConfig(f);
        const config = await read(f.destination);
        assert.deepEqual(await readFile(config.certificatePath), tls.ca);
        assert.equal(config.fingerprint256, f.value.fingerprint256);
      });
    await t.test(
      'configuração permanente mais atual prevalece sobre credencial antiga',
      async () => {
        const f = await fixture('newer');
        await mkdir(f.directory);
        const newer = { ...f.value, password: 'qa-newer-password', username: 'qa-current-user' };
        await writeFile(f.destination, JSON.stringify(newer));
        await preserveIdSecureConfig(f);
        const actual = await read(f.destination);
        assert.equal(actual.password, newer.password);
        assert.equal(actual.username, newer.username);
        assert.equal(actual.sourceId, newer.sourceId);
      },
    );
    await t.test(
      'configuração permanente mais nova com PEM relativo à release anterior mantém a credencial',
      async () => {
        const f = await fixture('persistent-relative-old-root');
        await mkdir(f.directory);
        const newer = {
          ...f.value,
          password: 'qa-password-newer-than-release',
          certificatePath: '.porto-runtime/trusted.pem',
        };
        await writeFile(f.destination, JSON.stringify(newer));
        await preserveIdSecureConfig(f);
        const actual = await read(f.destination);
        assert.equal(actual.password, newer.password);
        assert.equal(actual.fingerprint256, newer.fingerprint256);
        assert.ok(actual.certificatePath.startsWith(f.directory + sep));
        assert.deepEqual(await readFile(actual.certificatePath), tls.ca);
      },
    );
    await t.test(
      'gateway de outra origem não é redirecionado; arquivos existentes ficam intactos',
      async () => {
        const f = await fixture('different-central');
        await mkdir(f.directory);
        await writeFile(f.destination, JSON.stringify(f.value));
        const other = join(f.runtime, 'other.json');
        await writeFile(
          other,
          JSON.stringify({ ...f.value, origin: 'https://192.168.50.21:30443' }),
        );
        const exit = {
          version: 1,
          enabled: true,
          credentialFile: other,
          target: { sourceId: f.value.sourceId },
        };
        await writeFile(f.exit, JSON.stringify(exit));
        const before = await readFile(f.destination, 'utf8');
        await assert.rejects(preserveIdSecureConfig(f), /origens diferentes/);
        assert.equal(await readFile(f.destination, 'utf8'), before);
        assert.deepEqual(await read(f.exit), exit);
        assert.deepEqual((await readdir(f.directory)).sort(), [
          'exit-access.json',
          'idsecure.json',
        ]);
      },
    );
    await t.test(
      'fingerprint divergente recusa migração sem criar credencial permanente',
      async () => {
        const f = await fixture('wrong-pin');
        await writeFile(
          f.legacy,
          JSON.stringify({ ...f.value, fingerprint256: 'AA:'.repeat(31) + 'AA' }),
        );
        await assert.rejects(preserveIdSecureConfig(f), /fingerprint/);
        await assert.rejects(readFile(f.destination), { code: 'ENOENT' });
        assert.deepEqual(await readdir(f.directory), []);
      },
    );
    await t.test('sourceId divergente da saída não é aceito mesmo com a mesma origem', async () => {
      const f = await fixture('different-source');
      await mkdir(f.directory);
      const exit = {
        version: 1,
        enabled: false,
        credentialFile: f.legacy,
        target: { sourceId: 'another-source' },
      };
      await writeFile(f.exit, JSON.stringify(exit));
      await assert.rejects(preserveIdSecureConfig(f), /origens diferentes/);
      await assert.rejects(readFile(f.destination), { code: 'ENOENT' });
      assert.deepEqual(await read(f.exit), exit);
    });
    await t.test('arquivo de confiança com chave privada não é copiado', async () => {
      const f = await fixture('certificate-with-key');
      await writeFile(f.cert, Buffer.concat([tls.ca, tls.privateKey]));
      await assert.rejects(preserveIdSecureConfig(f), /chave privada/);
      await assert.rejects(readFile(f.destination), { code: 'ENOENT' });
      assert.deepEqual(await readdir(f.directory), []);
    });
    await t.test('configuração física da release antiga é preservada desativada', async () => {
      const f = await fixture('legacy-exit');
      await writeFile(
        join(f.runtime, 'exit-access.json'),
        JSON.stringify({
          version: 1,
          enabled: true,
          credentialFile: 'idsecure.json',
          target: { sourceId: f.value.sourceId },
        }),
      );
      const result = await preserveIdSecureConfig(f);
      assert.equal(result.exitAccess, 'migrated_disabled');
      assert.equal((await read(f.exit)).enabled, false);
      assert.equal((await read(f.exit)).credentialFile, f.destination);
    });
    await t.test(
      'perfil servidor usa DataRoot; desenvolvimento mantém caminho local; QA não herda instalação',
      async () => {
        const f = await fixture('profiles'),
          pg = {
            version: 1,
            provider: 'postgres',
            dataRoot: f.dataRoot,
            mediaRoot: join(f.dataRoot, 'media'),
            database: {
              host: '127.0.0.1',
              database: 'qa_fake',
              user: 'qa',
              password: 'fixture-only',
            },
            runtimeProfile: 'server',
          };
        const pgPath = join(f.releaseRoot, '.porto-runtime/postgres.json');
        await writeFile(pgPath, JSON.stringify(pg));
        const serverEnv = {};
        assert.equal(
          loadApplicationEnvironment({ root: f.releaseRoot, env: serverEnv }),
          'postgres',
        );
        assert.equal(serverEnv.PORTO_IDSECURE_CONFIG, f.destination);
        assert.equal(configuredIdSecurePath({ root: f.releaseRoot, env: {} }), f.destination);
        await writeFile(pgPath, JSON.stringify({ ...pg, runtimeProfile: undefined }));
        const devEnv = {};
        loadApplicationEnvironment({ root: f.releaseRoot, env: devEnv });
        assert.equal(
          devEnv.PORTO_IDSECURE_CONFIG,
          join(f.releaseRoot, '.porto-runtime/idsecure.json'),
        );
        // A malformed real profile proves an explicit QA environment never reads it.
        await writeFile(pgPath, 'not-json');
        const qaEnv = {
          PORTO_DB_PROVIDER: 'postgres',
          PORTO_PG_CONFIG: '{}',
          PORTO_MEDIA_ROOT: join(f.home, 'qa-media'),
        };
        assert.equal(loadApplicationEnvironment({ root: f.releaseRoot, env: qaEnv }), 'postgres');
        assert.equal(qaEnv.PORTO_IDSECURE_CONFIG, undefined);
        assert.throws(
          () => configuredIdSecurePath({ root: f.releaseRoot, env: qaEnv }),
          /não foi configurada/,
        );
        for (const partial of [
          { PORTO_DB_PROVIDER: 'postgres', PORTO_PG_CONFIG: '{}' },
          { PORTO_MEDIA_ROOT: join(f.home, 'partial-qa') },
        ]) {
          assert.throws(
            () => loadApplicationEnvironment({ root: f.releaseRoot, env: partial }),
            /explícito incompleto/,
          );
          assert.throws(
            () => configuredIdSecurePath({ root: f.releaseRoot, env: partial }),
            /não foi configurada/,
          );
          assert.equal(partial.PORTO_IDSECURE_CONFIG, undefined);
        }
        const override = join(f.home, 'explicit-fixture.json');
        assert.equal(
          configuredIdSecurePath({
            root: f.releaseRoot,
            env: { ...qaEnv, PORTO_IDSECURE_CONFIG: override },
          }),
          override,
        );
        assert.equal(
          configuredIdSecurePath({ root: f.releaseRoot, env: qaEnv, explicitPath: override }),
          override,
        );
        assert.equal(
          integrationConfigPaths({
            projectRoot: f.releaseRoot,
            env: { ...qaEnv, PORTO_IDSECURE_CONFIG: '' },
          }).idsecure,
          null,
        );
      },
    );
    await t.test('salvamento concorrente não substitui configuração mais nova', async () => {
      const f = await fixture('conflict');
      await mkdir(f.directory);
      await writeFile(f.destination, 'original');
      await withIntegrationConfigLock(f.destination, async () => {
        await assert.rejects(
          withIntegrationConfigLock(f.destination, async () => {}),
          /bloqueio/,
        );
        await writeFile(f.destination, 'newer');
        await assert.rejects(
          replaceIntegrationJson(f.destination, { password: 'fixture' }, 'original'),
          /mudou/,
        );
      });
      assert.equal(await readFile(f.destination, 'utf8'), 'newer');
    });
    await t.test(
      'CLIs de importação e planejamento recusam banco QA antes de ler credencial ou dados instalados',
      async () => {
        const f = await fixture('cli-qa-gate'),
          env = {
            ...process.env,
            PORTO_DB_PROVIDER: 'postgres',
            PORTO_PG_CONFIG: JSON.stringify({ database: 'qa_never_connect' }),
            PORTO_MEDIA_ROOT: join(f.home, 'never-use-media'),
            PORTO_IDSECURE_CONFIG: join(f.home, 'never-read-credential.json'),
          };
        for (const [script, args] of [
          ['scripts/import-idsecure.mjs', ['--preview']],
          ['scripts/import-idsecure.mjs', ['--apply']],
          ['scripts/visitor-face-plan.mjs', []],
        ]) {
          const result = spawnSync(
            process.execPath,
            ['--experimental-strip-types', script, ...args],
            { encoding: 'utf8', windowsHide: true, env },
          );
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /perfil PostgreSQL instalado/);
          assert.doesNotMatch(result.stderr, /ENOENT|ECONNREFUSED/);
          assert.equal(result.stdout, '');
        }
        await assert.rejects(readFile(env.PORTO_IDSECURE_CONFIG), { code: 'ENOENT' });
      },
    );
    await t.test(
      'runner de servidor configura caminhos permanentes em processo filho isolado',
      { skip: process.platform !== 'win32' },
      async () => {
        const f = await fixture('runner'),
          install = join(f.home, 'install');
        await mkdir(install);
        await mkdir(join(f.releaseRoot, 'scripts'));
        await mkdir(join(f.dataRoot, 'logs'));
        await writeFile(
          join(f.releaseRoot, '.porto-runtime/postgres.json'),
          JSON.stringify({
            version: 1,
            provider: 'postgres',
            database: { database: 'qa_fake' },
            mediaRoot: join(f.dataRoot, 'media'),
          }),
        );
        // Simulate an older release without runtimeProfile and with a leftover enabled file.
        // The child only loads environment settings; it never creates resources or connects.
        await writeFile(
          join(f.releaseRoot, '.porto-runtime/exit-access.json'),
          JSON.stringify({ enabled: true }),
        );
        await writeFile(
          join(f.releaseRoot, 'scripts/server-process.mjs'),
          `import {loadApplicationEnvironment} from ${JSON.stringify(pathToFileURL(resolve('scripts/postgres-config.mjs')).href)};loadApplicationEnvironment({root:process.cwd()});console.log(JSON.stringify({idsecure:process.env.PORTO_IDSECURE_CONFIG,exit:process.env.PORTO_EXIT_CONFIG}));`,
        );
        await writeFile(
          join(install, 'current.json'),
          JSON.stringify({
            root: f.releaseRoot,
            dataRoot: f.dataRoot,
            node: process.execPath,
            portoEnabled: false,
          }),
        );
        const result = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            resolve('server/RUN-SERVER.ps1'),
            '-InstallRoot',
            install,
          ],
          {
            encoding: 'utf8',
            windowsHide: true,
            env: {
              ...process.env,
              PORTO_IDSECURE_CONFIG: join(f.home, 'wrong-old-release.json'),
              PORTO_EXIT_CONFIG: join(f.releaseRoot, '.porto-runtime/exit-access.json'),
            },
          },
        );
        assert.equal(result.status, 0, result.stderr);
        const bytes = await readFile(join(f.dataRoot, 'logs/application.log')),
          text = (
            bytes[0] === 255 && bytes[1] === 254
              ? bytes.toString('utf16le')
              : bytes.toString('utf8')
          ).replace(/^\uFEFF/, '');
        const actual = JSON.parse(text.trim());
        assert.equal(actual.idsecure, f.destination);
        assert.equal(actual.exit, f.exit);
        await assert.rejects(readFile(actual.exit), { code: 'ENOENT' });
      },
    );
  } finally {
    assert.ok(resolve(base).startsWith(resolve(tmpdir()) + sep));
    await rm(base, { recursive: true, force: true });
  }
});
