import { chromium, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { withPostgresFixture } from './support/postgres-fixture.mjs';
import { hashPassword } from '../lib/local-auth.ts';
import { handleApi } from '../lib/server.ts';
const output = resolve('.porto-tooling/turnstile-review');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'portaria-monitor-qa-'));
let browser,
  child,
  logs = '';
const errors = [],
  violations = [],
  screenshots = [];
async function port() {
  const socket = createServer();
  await new Promise((done) => socket.listen(0, '127.0.0.1', done));
  const value = socket.address().port;
  await new Promise((done) => socket.close(done));
  return value;
}
try {
  await withPostgresFixture(
    async ({ owner, db, database, role, password: appPassword, adminConfig }) => {
      try {
        await handleApi(new Request('http://127.0.0.1/api/session'), db);
        const password = randomBytes(24).toString('hex'),
          credential = await hashPassword(password),
          now = new Date().toISOString();
        await owner.query(
          "INSERT INTO operational_users(id,email,name,role,status,created_at,updated_at) VALUES('admin','admin@example.test','Admin QA','admin','active',$1,$1)",
          [now],
        );
        await owner.query(
          "INSERT INTO operational_credentials(user_id,username,password_hash,password_salt,password_iterations,password_changed_at,must_change_password) VALUES('admin','monitor.qa',$1,$2,$3,$4,0)",
          [credential.hash, credential.salt, credential.iterations, now],
        );
        const media = join(temporary, 'media');
        await mkdir(media);
        const uiPort = await port(),
          origin = 'http://127.0.0.1:' + uiPort;
        child = spawn(
          process.execPath,
          [
            '--experimental-strip-types',
            'scripts/run-framework.mjs',
            'start',
            '--hostname',
            '127.0.0.1',
            '--port',
            String(uiPort),
          ],
          {
            windowsHide: true,
            detached: process.platform !== 'win32',
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
              PORTO_IDSECURE_CONFIG: join(temporary, 'no-real-integration.json'),
              PORTO_EXIT_CONFIG: join(temporary, 'no-real-exit-integration.json'),
              PORTO_NATIVE_PROCESS_FILE: join(temporary, 'process.json'),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (value) => {
            logs = (logs + value).slice(-6000);
          });
        const deadline = Date.now() + 60000;
        while (
          !(await fetch(origin)
            .then((r) => r.ok)
            .catch(() => false))
        ) {
          if (Date.now() > deadline || child.exitCode !== null)
            throw Error('QA não iniciou. ' + logs);
          await new Promise((done) => setTimeout(done, 250));
        }
        browser = await chromium.launch({
          headless: true,
          ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
        });
        const context = await browser.newContext({
          viewport: { width: 1366, height: 900 },
          reducedMotion: 'no-preference',
        });
        expect(
          (
            await context.request.post(origin + '/api/auth/login', {
              headers: { origin },
              data: { username: 'monitor.qa', password },
            })
          ).status(),
        ).toBe(200);
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.on('pageerror', (e) => errors.push(e.message));
        const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
        const samples = [
          [
            'Pessoa fictícia QA 0',
            'Catraca principal QA',
            'Recepção QA',
            'Acesso autorizado',
            'authorized',
          ],
          [
            'Convidada fictícia QA 1',
            'Catraca visitantes QA',
            'Recepção QA',
            'Acesso negado',
            'denied',
          ],
          [
            'Pessoa fictícia QA 2',
            'Catraca pátio QA',
            'Área externa QA',
            'Acesso pendente',
            'pending',
          ],
          [
            'Pessoa não identificada QA',
            'Catraca principal QA',
            'Área interna QA',
            'Não identificado',
            'unidentified',
          ],
          [
            'Pessoa fictícia QA 4',
            'Catraca visitantes QA',
            'Recepção QA',
            'Acesso autorizado',
            'authorized',
          ],
          [
            'Pessoa fictícia QA 5',
            'Catraca pátio QA',
            'Área externa QA',
            'Acesso autorizado',
            'authorized',
          ],
          [
            'Pessoa fictícia QA 6',
            'Catraca principal QA',
            'Área interna QA',
            'Acesso autorizado',
            'authorized',
          ],
        ];
        const events = samples.map(([name, device, area, eventName, kind], i) => ({
          id: 'device:' + i,
          name,
          device,
          area,
          eventName,
          kind,
          occurredAt: new Date(Date.now() - i * 60000).toISOString(),
          personId: i === 3 ? null : 'person-qa',
          photoUrl: i === 0 ? '/api/people/person-qa/photo?v=fixture' : null,
          passageConfirmed: false,
        }));
        let state = 'connected',
          queries = 0,
          lastSuccessAt = new Date().toISOString();
        await context.route('**/api/integrations/idsecure/monitor', async (route) => {
          queries++;
          if (state === 'connected') lastSuccessAt = new Date().toISOString();
          await route.fulfill({
            status: state === 'http-error' ? 503 : state === 'denied' ? 403 : 200,
            contentType: 'application/json',
            body: JSON.stringify({
              source: 'iDSecure',
              status: state === 'offline' ? 'offline' : 'connected',
              lastSuccessAt:
                state === 'stale' ? new Date(Date.now() - 120000).toISOString() : lastSuccessAt,
              events,
              passageEvidence: 'not_validated',
            }),
          });
        });
        await context.route('**/api/people/person-qa/photo?**', (route) =>
          route.fulfill({
            contentType: 'image/png',
            body: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1UAAAAASUVORK5CYII=',
              'base64',
            ),
          }),
        );
        await page.goto(origin);
        const panel = page.getByRole('region', { name: 'Movimentação das catracas', exact: true }),
          latest = panel.locator('.turnstile-latest'),
          identity = latest.locator('.turnstile-identity'),
          history = panel.locator('.turnstile-list'),
          historyRows = history.locator('.turnstile-row');
        await expect(
          panel.getByRole('heading', { name: 'Pessoa fictícia QA 0', exact: true }),
        ).toBeVisible();
        await expect
          .poll(() => latest.locator('img.turnstile-photo').evaluate((img) => img.naturalWidth))
          .toBeGreaterThan(0);
        await expect(historyRows).toHaveCount(3);
        await expect(history.getByText(events[0].name, { exact: true })).toHaveCount(0);
        await expect(latest).not.toHaveAttribute('data-new', 'true');
        async function capture(label) {
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            label + ' overflow',
          ).toBe(true);
          await page.addScriptTag({ path: axe });
          const report = await page.evaluate(async () =>
            window.axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
            }),
          );
          violations.push(
            ...report.violations.map((v) => ({
              label,
              id: v.id,
              summary: v.nodes.map((n) => n.failureSummary),
            })),
          );
          await panel.scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(output, label + '.png'), animations: 'disabled' });
          screenshots.push(label);
        }
        await capture('monitor-1366');
        events[0] = {
          ...events[0],
          id: 'device:new',
          name: 'Novo evento fictício QA',
          eventName: 'Acesso pendente',
          kind: 'pending',
          occurredAt: new Date().toISOString(),
        };
        await expect(
          latest.getByRole('heading', { name: events[0].name, exact: true }),
        ).toBeVisible();
        await expect(latest).toHaveAttribute('data-new', 'true');
        await expect(identity).toHaveCSS('animation-name', 'turnstile-event-arrival');
        expect(queries).toBeGreaterThan(1);
        const afterArrival = queries;
        await expect.poll(() => queries).toBeGreaterThan(afterArrival);
        await expect(latest).not.toHaveAttribute('data-new', 'true');
        await expect(identity).toHaveCSS('animation-name', 'none');

        await page.emulateMedia({ reducedMotion: 'reduce' });
        events[0] = {
          ...events[0],
          id: 'device:reduced-motion',
          name: 'Outro evento fictício QA',
          eventName: 'Acesso autorizado',
          kind: 'authorized',
          occurredAt: new Date().toISOString(),
        };
        await expect(
          latest.getByRole('heading', { name: events[0].name, exact: true }),
        ).toBeVisible();
        await expect(latest).toHaveAttribute('data-new', 'true');
        await expect(identity).toHaveCSS('animation-name', 'none');

        state = 'stale';
        await expect(
          panel.getByRole('status').filter({ hasText: 'Sem confirmação recente' }),
        ).toBeVisible();
        await expect(
          latest.getByRole('heading', { name: events[0].name, exact: true }),
        ).toBeVisible();
        state = 'offline';
        await expect(
          panel.getByRole('status').filter({ hasText: 'Conexão indisponível' }),
        ).toBeVisible();
        await expect(
          latest.getByRole('heading', { name: events[0].name, exact: true }),
        ).toBeVisible();
        await capture('monitor-offline');
        state = 'http-error';
        await expect(
          panel.getByText('Não foi possível consultar a central.', { exact: false }),
        ).toBeVisible();
        await expect(
          latest.getByRole('heading', { name: events[0].name, exact: true }),
        ).toBeVisible();
        state = 'connected';
        await expect(
          panel.getByRole('status').filter({ hasText: 'iDSecure conectado' }),
        ).toBeVisible();
        for (const width of [768, 390, 360]) {
          await page.setViewportSize({ width, height: 844 });
          await capture('monitor-' + width);
        }
        await expect(historyRows).toHaveCount(3);
        const expand = panel.getByRole('button', { name: 'Ver todos os eventos', exact: true });
        await expect(expand).toHaveAttribute('aria-expanded', 'false');
        await expand.click();
        await expect(historyRows).toHaveCount(6);
        await expect(history.getByText(events[0].name, { exact: true })).toHaveCount(0);
        await capture('monitor-expandido-360');
        const collapse = panel.getByRole('button', { name: 'Mostrar menos', exact: true });
        await expect(collapse).toHaveAttribute('aria-expanded', 'true');
        await page.setViewportSize({ width: 360, height: 560 });
        const scrollable = panel.getByRole('list', { name: 'Eventos anteriores' });
        await expect(scrollable).toHaveAttribute('tabindex', '0');
        await expect
          .poll(() => scrollable.evaluate((list) => list.scrollHeight > list.clientHeight))
          .toBe(true);
        await scrollable.press('End');
        await expect.poll(() => scrollable.evaluate((list) => list.scrollTop)).toBeGreaterThan(0);
        await collapse.click();
        await expect(historyRows).toHaveCount(3);
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        const before = queries;
        await page.waitForTimeout(6500);
        expect(queries).toBe(before);
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, value: false });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await expect.poll(() => queries).toBeGreaterThan(before);
        state = 'denied';
        await expect(
          panel.getByText('Sua sessão ou permissão de consulta mudou.', { exact: false }),
        ).toBeVisible();
        await expect(panel.locator('.turnstile-row')).toHaveCount(0);
        const stopped = queries;
        await page.waitForTimeout(4000);
        expect(queries).toBe(stopped);
        expect((await owner.query('SELECT count(*) AS n FROM operational_records')).rows[0].n).toBe(
          '0',
        );
        expect(errors).toEqual([]);
        expect(violations).toEqual([]);
      } finally {
        if (browser) {
          await browser.close();
          browser = null;
        }
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((done) => child.once('exit', done));
          if (process.platform === 'win32')
            spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            });
          else process.kill(-child.pid, 'SIGTERM');
          await exited;
        }
      }
    },
  );
  console.log(JSON.stringify({ screenshots: screenshots.length, errors, violations }));
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await writeFile(
    join(output, 'relatorio.json'),
    JSON.stringify({ screenshots, errors, violations }, null, 2),
  );
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep)) throw Error('Pasta QA inválida.');
  await rm(temporary, { recursive: true, force: true });
}
