import { chromium, expect as baseExpect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { withPostgresFixture } from './support/postgres-fixture.mjs';
import { centralFixture } from './support/idsecure-central-fixture.mjs';
import { hashPassword } from '../lib/local-auth.ts';
import { handleApi } from '../lib/server.ts';

const expect = baseExpect.configure({ timeout: 30000 });
const output = resolve('.porto-tooling/controlid-browser');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'portaria-controlid-ui-qa-'));
const screenshots = [],
  errors = [],
  vendorRequests = [];
let child,
  browser,
  central,
  logs = '';

async function unusedPort() {
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const value = socket.address().port;
  await new Promise((done) => socket.close(done));
  return value;
}
async function ready(origin) {
  const deadline = Date.now() + 90000;
  while (
    !(await fetch(origin)
      .then((response) => response.ok)
      .catch(() => false))
  ) {
    if (Date.now() > deadline || child.exitCode !== null)
      throw Error('A aplicação isolada de QA não iniciou.');
    await new Promise((done) => setTimeout(done, 250));
  }
}
async function stopApplication() {
  if (browser) {
    await browser.close();
    browser = null;
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise((done) => child.once('exit', done));
    child.kill('SIGTERM');
    await ended;
  }
}

try {
  const vendorRoot = join(temporary, 'vendor');
  await mkdir(vendorRoot);
  central = await centralFixture(vendorRoot);
  central.server.on('request', (request) =>
    vendorRequests.push({
      method: request.method,
      path: new URL(request.url, 'https://127.0.0.1').pathname,
    }),
  );
  const configurationPath = join(temporary, 'installation', 'integrations', 'idsecure.json');
  await withPostgresFixture(
    async ({ owner, db, database, role, password: appPassword, adminConfig }) => {
      try {
        await handleApi(new Request('http://127.0.0.1/api/session'), db);
        const password = randomBytes(24).toString('hex'),
          credential = await hashPassword(password),
          now = new Date().toISOString();
        for (const actor of ['admin', 'reader']) {
          await owner.query(
            "INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',$5,$5)",
            [
              'controlid-' + actor,
              'controlid-' + actor + '@example.test',
              'Control iD QA ' + actor,
              actor,
              now,
            ],
          );
          await owner.query(
            'INSERT INTO operational_credentials(user_id,username,password_hash,password_salt,password_iterations,password_changed_at,must_change_password) VALUES($1,$2,$3,$4,$5,$6,0)',
            [
              'controlid-' + actor,
              'controlid.' + actor,
              credential.hash,
              credential.salt,
              credential.iterations,
              now,
            ],
          );
        }
        const media = join(temporary, 'media');
        await mkdir(media);
        const origin = 'http://127.0.0.1:' + (await unusedPort());
        child = spawn(
          process.execPath,
          [
            '--experimental-strip-types',
            'scripts/run-framework.mjs',
            'start',
            '--hostname',
            '127.0.0.1',
            '--port',
            new URL(origin).port,
          ],
          {
            windowsHide: true,
            env: {
              ...process.env,
              PORTO_DB_PROVIDER: 'postgres',
              PORTO_PG_CONFIG: JSON.stringify({
                ...adminConfig,
                database,
                user: role,
                password: appPassword,
              }),
              PORTO_MEDIA_ROOT: media,
              PORTO_IDSECURE_CONFIG: configurationPath,
              PORTO_EXIT_CONFIG: join(temporary, 'physical-integration-not-configured.json'),
              PORTO_NATIVE_PROCESS_FILE: join(temporary, 'process.json'),
              PORTO_DEPLOYMENT_STAGE: 'homologation',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (value) => {
            logs = (logs + value).slice(-8000);
          });
        await ready(origin);
        browser = await chromium.launch({
          headless: true,
          ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
        });
        const context = await browser.newContext({
          viewport: { width: 1366, height: 1000 },
          reducedMotion: 'reduce',
        });
        const login = await context.request.post(origin + '/api/auth/login', {
          headers: { origin },
          data: { username: 'controlid.admin', password },
        });
        expect(login.status()).toBe(200);
        const page = await context.newPage();
        page.setDefaultTimeout(30000);
        page.on('pageerror', (error) => errors.push(error.message));
        async function openSettings() {
          await expect(page.locator('main h1')).toBeVisible();
          if (page.viewportSize().width <= 1024)
            await page.getByRole('button', { name: 'Abrir menu', exact: true }).click();
          await page
            .getByRole('navigation', { name: 'Navegação principal' })
            .getByRole('button', { name: 'Administração', exact: true })
            .click();
          await page
            .getByRole('navigation', { name: 'Configurações', exact: true })
            .getByRole('button', { name: 'Control iD', exact: true })
            .click();
          await expect(
            page.getByRole('heading', { name: 'Conexão Control iD / iDSecure', exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole('button', { name: 'Testar conexão', exact: true }),
          ).toBeEnabled();
        }
        async function capture(label) {
          await expect
            .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
            .toBeLessThanOrEqual(1);
          await page.screenshot({
            path: join(output, label + '.png'),
            fullPage: true,
            animations: 'disabled',
          });
          screenshots.push(label);
        }
        async function safeConfiguration() {
          const response = await context.request.get(origin + '/api/admin/controlid');
          expect(response.status()).toBe(200);
          const value = await response.json(),
            text = JSON.stringify(value);
          expect(text.includes(central.credentials.password)).toBe(false);
          expect(text.includes('qa-ephemeral-token')).toBe(false);
          for (const key of [
            'password',
            'certificatePath',
            'credentialFile',
            'certificatePem',
            'token',
            'accessToken',
          ])
            expect(Object.hasOwn(value, key)).toBe(false);
          return value;
        }
        async function saveConnection() {
          const saving = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === '/api/admin/controlid' &&
              response.request().method() === 'PUT',
          );
          await page.getByRole('button', { name: 'Salvar conexão', exact: true }).click();
          let response = await saving;
          if (response.status() === 429) {
            await expect(
              page.getByRole('button', { name: 'Salvar conexão', exact: true }),
            ).toBeEnabled();
            const retry = page.waitForResponse(
              (next) =>
                new URL(next.url()).pathname === '/api/admin/controlid' &&
                next.request().method() === 'PUT',
            );
            await page.getByRole('button', { name: 'Salvar conexão', exact: true }).click();
            response = await retry;
          }
          expect(response.status()).toBe(200);
          await expect(
            page.getByText('Conexão validada e salva. A senha permanece protegida.', {
              exact: true,
            }),
          ).toBeVisible();
          await expect(page.getByLabel('Senha da central', { exact: true })).toHaveValue('');
        }
        await page.goto(origin);
        await openSettings();
        expect((await safeConfiguration()).configured).toBe(false);
        expect(vendorRequests).toHaveLength(0);
        await page
          .getByLabel('Endereço HTTPS da central', { exact: true })
          .fill(central.credentials.origin);
        await page
          .getByLabel('Usuário da central', { exact: true })
          .fill(central.credentials.username);
        await page
          .getByLabel('Senha da central', { exact: true })
          .fill(central.credentials.password);
        await page
          .getByLabel('Identificador da integração', { exact: true })
          .fill('qa-controlid-ui');
        await page
          .getByLabel('Selecionar certificado PEM', { exact: true })
          .setInputFiles(central.tls.cert);
        await expect(page.getByLabel('Conteúdo do certificado PEM', { exact: true })).toHaveValue(
          /-----BEGIN CERTIFICATE-----/,
        );
        const testing = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/admin/controlid/test',
        );
        await page.getByRole('button', { name: 'Testar conexão', exact: true }).click();
        expect((await testing).status()).toBe(200);
        await expect(
          page.getByText('A central respondeu ao teste de conexão.', { exact: true }),
        ).toBeVisible();
        expect((await safeConfiguration()).configured).toBe(false);
        await capture('controlid-teste-desktop');
        await saveConnection();
        const saved = await safeConfiguration();
        expect(saved.configured).toBe(true);
        expect(saved.passwordConfigured).toBe(true);
        expect(saved.certificateValid).toBe(true);
        expect(saved.sourceId).toBe('qa-controlid-ui');
        await expect(
          page.getByLabel('Identificador da integração', { exact: true }),
        ).toHaveAttribute('readonly', '');
        await expect(page.getByLabel('Conteúdo do certificado PEM', { exact: true })).toHaveValue(
          '',
        );
        await capture('controlid-salvo-desktop');
        await page.reload();
        await openSettings();
        await expect(page.getByLabel('Endereço HTTPS da central', { exact: true })).toHaveValue(
          central.credentials.origin,
        );
        await expect(page.getByLabel('Senha da central', { exact: true })).toHaveValue('');
        await saveConnection();
        const stored = JSON.parse(await readFile(configurationPath, 'utf8'));
        expect(stored.password === central.credentials.password).toBe(true);
        expect(stored.mode).toBe('read_only');
        const audit = JSON.stringify(
          (await owner.query('SELECT body FROM operational_audit')).rows,
        );
        expect(audit.includes(central.credentials.password)).toBe(false);
        expect(audit.includes('qa-ephemeral-token')).toBe(false);
        expect(audit.includes('BEGIN CERTIFICATE')).toBe(false);
        const browserState = await page.evaluate(() =>
          JSON.stringify({
            local: { ...localStorage },
            session: { ...sessionStorage },
            text: document.body.innerText,
          }),
        );
        expect(browserState.includes(central.credentials.password)).toBe(false);
        expect(browserState.includes('qa-ephemeral-token')).toBe(false);
        await page.setViewportSize({ width: 390, height: 844 });
        await capture('controlid-salvo-mobile');
        const reader = await browser.newContext();
        expect(
          (
            await reader.request.post(origin + '/api/auth/login', {
              headers: { origin },
              data: { username: 'controlid.reader', password },
            })
          ).status(),
        ).toBe(200);
        const denied = await reader.request.get(origin + '/api/admin/controlid');
        expect(denied.status()).toBe(403);
        expect((await denied.text()).includes(central.credentials.origin)).toBe(false);
        await reader.close();
        expect(vendorRequests.length).toBeGreaterThan(0);
        expect(
          vendorRequests.every(
            (entry) =>
              (entry.method === 'POST' && entry.path === '/api/login/') ||
              (entry.method === 'GET' &&
                ['/api/util/configUI', '/api/access/monitor'].includes(entry.path)),
          ),
        ).toBe(true);
        expect(central.rules.size).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await stopApplication();
      }
    },
  );
  console.log(JSON.stringify({ status: 'passed', screenshots, errors, vendorRequests }));
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await stopApplication();
  await central?.close();
  await writeFile(
    join(output, 'relatorio.json'),
    JSON.stringify({ screenshots, errors, vendorRequests }, null, 2),
  );
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep)) throw Error('Pasta de QA inválida.');
  await rm(temporary, { recursive: true, force: true });
}
